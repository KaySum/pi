-- One call formats files with the formatters this Neovim is configured with (conform.nvim
-- if installed, otherwise the files' language servers) and writes back what changed.
local request = ...
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local now = function() return uv.hrtime() / 1e6 end
-- With no formatter of its own, a file is formatted by a language server, and a client may
-- be created a moment after a buffer loads; much later on a filetype's first use.
local ATTACH_MS, FIRST_ATTACH_MS = 300, 2000
-- A server's error is not final if it says its state changed under the request
-- (ContentModified, ServerCancelled), or if the server is showing progress, as one loading
-- its project does: the file is tried again, this often and this far apart.
local TRANSIENT, ATTEMPTS, RETRY_MS = { [-32801] = true, [-32802] = true }, 5, 300

local S = _G.__pi_nvim_format_v1 or { filetypes = {} }
_G.__pi_nvim_format_v1 = S
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

-- A server answers about its own copy of the file, and edits made for another text ruin
-- this one. rust-analyzer's copy can miss a change made while it loads a project, so the
-- server is sent the buffer afresh, as on a reload, before it is asked.
local function resend(client, buf)
  local uri = vim.uri_from_bufnr(buf)
  client:notify('textDocument/didClose', { textDocument = { uri = uri } })
  client:notify('textDocument/didOpen', { textDocument = { uri = uri, version = lsp.util.buf_versions[buf],
    languageId = client.get_language_id(buf, vim.bo[buf].filetype), text = lsp._buf_get_full_text(buf) } })
  -- A reopened file makes some servers publish its diagnostics anew; a no-op change gives
  -- the text a new version, by which nvim-diagnostics knows to wait for them.
  local modified = vim.bo[buf].modified
  api.nvim_buf_set_lines(buf, 0, 1, false, api.nvim_buf_get_lines(buf, 0, 1, false))
  vim.bo[buf].modified = modified
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
    resend(client, buf)
    -- Not vim.lsp.buf.format: it tells the user of a server's error or silence and carries on.
    local reply, silence = client:request_sync(FORMATTING, lsp.util.make_formatting_params(), left(), buf)
    local err = reply and reply.err
    if err then return ('%s: %s'):format(client.name, err.message or err.code), TRANSIENT[err.code] or next(client.progress.pending) ~= nil end
    if not reply then return ('%s: %s'):format(client.name, silence) end
    if type(reply.result) == 'table' then lsp.util.apply_text_edits(reply.result, buf, client.offset_encoding) end
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
