-- One call formats files with the formatters this Neovim is configured with (conform.nvim
-- if installed, otherwise the files' language servers) and writes back what changed.
local request = ...
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local now = function() return uv.hrtime() / 1e6 end
-- With no formatter of its own, a file is formatted by a language server, and a client may
-- be created a moment after a buffer loads; much later on a filetype's first use.
local ATTACH_MS, FIRST_ATTACH_MS = 300, 2000
-- A server showing progress is loading, and may answer about the file as it was before:
-- rust-analyzer takes in no changes while it scans a project, and edits made for an older
-- text ruin this one. So a server is only asked once it has shown no progress for this
-- long, and its answer is dropped if it showed any before the answer came.
local CALM_MS = 500
-- A server's error is not final if it says its state changed under the request
-- (ContentModified, ServerCancelled) or it began loading meanwhile: the file is tried
-- again, this often and this far apart.
local TRANSIENT, ATTEMPTS, RETRY_MS = { [-32801] = true, [-32802] = true }, 5, 300

-- Remembered for the life of this Neovim: the file types seen, and when each language
-- server last reported progress.
local S = _G.__pi_nvim_format_v2
if not S then
  S = { filetypes = {}, progress = {} }
  _G.__pi_nvim_format_v2 = S
  api.nvim_create_autocmd('LspProgress', {
    group = api.nvim_create_augroup('PiNvimFormat', {}),
    callback = function(ev) S.progress[ev.data.client_id] = uv.hrtime() / 1e6 end,
  })
end
local started = now()
local left = function() return math.max(0, request.timeoutMs - (now() - started)) end
local has_conform, conform = pcall(require, 'conform')
local FORMATTING = 'textDocument/formatting'

-- What would format the buffer right now: conform's own formatters, by name, and the
-- language servers that follow them. The servers are always asked from here, not through
-- conform, which passes on their errors as text and gives each the whole time allowed.
local function plan(buf)
  local names, servers = {}, true
  if has_conform then
    local list
    list, servers = conform.list_formatters_to_run(buf)
    for _, formatter in ipairs(list) do table.insert(names, formatter.name) end
  end
  return names, servers and lsp.get_clients({ bufnr = buf, method = FORMATTING }) or {}
end

-- Ask one server how to format the current buffer: its edits, or nil, what went wrong and
-- whether asking again may help.
local function ask(client, buf)
  -- What a server did before it was first seen here is unknown, so it starts out as busy.
  S.progress[client.id] = S.progress[client.id] or now()
  local busy = function() return next(client.progress.pending) ~= nil end
  if not vim.wait(left(), function() return not busy() and now() - S.progress[client.id] >= CALM_MS end, 20) then
    return nil, client.name .. ': timeout while it was loading'
  end
  local asked = now()
  -- Not vim.lsp.buf.format: it tells the user of a server's error or silence and carries on.
  local reply, silence = client:request_sync(FORMATTING, lsp.util.make_formatting_params(), left(), buf)
  local moved = busy() or S.progress[client.id] >= asked
  local err = reply and reply.err
  if err then return nil, ('%s: %s'):format(client.name, err.message or err.code), TRANSIENT[err.code] or moved end
  if not reply then return nil, ('%s: %s'):format(client.name, silence) end
  if moved then return nil, client.name .. ' began loading while it was asked', true end
  return type(reply.result) == 'table' and reply.result or {}
end

-- Format the current buffer without writing it; returns what went wrong, if anything, and
-- whether trying again may help.
local function run(buf)
  local names, clients = plan(buf)
  -- Putting a buffer back after a failure can detach its servers for a moment.
  if #names + #clients == 0 then return 'its language servers are not attached', true end
  if #names > 0 then
    local failure
    conform.format({ bufnr = buf, formatters = names, lsp_format = 'never', async = false, quiet = true, timeout_ms = left() }, function(e) failure = e end)
    if failure then return failure end
  end
  for _, client in ipairs(clients) do
    local edits, problem, again = ask(client, buf)
    if problem then return problem, again end
    lsp.util.apply_text_edits(edits, buf, client.offset_encoding)
  end
end

-- The whole batch is opened before any of it is formatted, so that a server hears of every
-- file as it starts. rust-analyzer fails requests about a file it was shown while still
-- loading its project.
local opened = {}
for _, path in ipairs(request.files) do
  local stat = uv.fs_stat(path)
  local buf = stat and stat.type == 'file' and vim.fn.bufadd(path)
  if buf and not api.nvim_buf_is_loaded(buf) then
    vim.fn.bufload(buf)
    opened[buf] = now()
  end
end

local function format(path)
  local out = { path = path }
  local stat = uv.fs_stat(path)
  if not stat or stat.type ~= 'file' then out.error = stat and 'not a regular file' or 'no such file'; return out end
  local buf = vim.fn.bufadd(path)
  local fresh = opened[buf] ~= nil
  -- Formatting it would write those changes to the file along with the formatting.
  if vim.bo[buf].modified then out.error = "not formatted: its buffer in Pi's Neovim has unsaved changes"; return out end
  -- Asked to write one anyway, an editor with 'confirm' set stops at a dialog.
  if vim.bo[buf].readonly or vim.fn.filewritable(path) ~= 1 then out.error = 'not formatted: the file is read-only'; return out end
  -- The file on disk is what gets formatted: pick up what was written since the buffer loaded.
  local tick = api.nvim_buf_get_changedtick(buf)
  vim.bo[buf].autoread = true
  vim.cmd('silent checktime ' .. buf)
  fresh = fresh or tick ~= api.nvim_buf_get_changedtick(buf)

  local loaded, filetype = opened[buf] or now(), vim.bo[buf].filetype
  vim.wait(left(), function()
    local names, clients = plan(buf)
    out.formatters = vim.list_extend(names, vim.tbl_map(function(client) return client.name end, clients))
    if #out.formatters > 0 then return true end
    local clients = lsp.get_clients({ bufnr = buf, _uninitialized = true })
    for _, client in ipairs(clients) do
      if not client.initialized then return false end
    end
    return #clients > 0 or not fresh or now() - loaded >= (S.filetypes[filetype] and ATTACH_MS or FIRST_ATTACH_MS)
  end, 20)
  S.filetypes[filetype] = true
  if #out.formatters == 0 then return out end
  if left() == 0 then out.error = 'not formatted: out of time'; return out end

  local function read()
    local file = assert(io.open(path, 'rb'))
    local bytes = file:read('*a')
    file:close()
    return bytes
  end
  local before, written, failure, again = read(), false, nil, nil
  for attempt = 1, ATTEMPTS do
    -- With the buffer current: language-server formatting asks about the current buffer,
    -- whichever one it was given.
    local ok, err = pcall(api.nvim_buf_call, buf, function()
      failure, again = run(buf)
      if not failure and left() == 0 then failure, again = 'timeout', false end
      if not failure and vim.bo[buf].modified then
        vim.cmd('silent noautocmd write')
        written = true
      end
    end)
    if not ok then failure, again = err, false end
    if not failure then break end
    -- A formatter that failed part-way must not leave a half-formatted buffer behind.
    if vim.bo[buf].modified then pcall(api.nvim_buf_call, buf, function() vim.cmd('silent keepalt keepjumps edit!') end) end
    if not again or attempt == ATTEMPTS or left() <= RETRY_MS then break end
    vim.wait(RETRY_MS)
  end
  if failure then
    out.error = 'failed: ' .. vim.trim(tostring(failure):gsub('\nstack traceback:.*', '')):gsub('%s+', ' '):sub(1, 500)
    return out
  end
  -- Where the file changed, as line ranges of what it holds now. Its bytes are compared, not
  -- the buffer's lines: a formatter may change only line endings or the final newline.
  out.changed = {}
  for _, hunk in ipairs(written and vim.diff(before, read(), { result_type = 'indices' }) or {}) do
    local first = math.max(hunk[3], 1)
    table.insert(out.changed, { first, first + math.max(hunk[4], 1) - 1 })
  end
  return out
end

local files = {}
for _, path in ipairs(request.files) do table.insert(files, format(path)) end
return { files = files }
