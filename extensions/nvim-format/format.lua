-- One call formats files with the formatters this Neovim is configured with (conform.nvim
-- if installed, otherwise the files' language servers) and writes back what changed.
local request = ...
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local now = function() return uv.hrtime() / 1e6 end
-- With no formatter of its own, a file is formatted by a language server, and a client may
-- be created a moment after a buffer loads; much later on a filetype's first use.
local ATTACH_MS, FIRST_ATTACH_MS = 300, 2000

local S = _G.__pi_nvim_format_v1 or { filetypes = {} }
_G.__pi_nvim_format_v1 = S
local started = now()
local left = function() return math.max(0, request.timeoutMs - (now() - started)) end
local has_conform, conform = pcall(require, 'conform')
local FORMATTING = 'textDocument/formatting'

-- What would format the buffer right now, by name.
local function formatters(buf)
  local names, servers = {}, not has_conform
  if has_conform then
    local list
    list, servers = conform.list_formatters_to_run(buf)
    for _, formatter in ipairs(list) do table.insert(names, formatter.name) end
  end
  for _, client in ipairs(servers and lsp.get_clients({ bufnr = buf, method = FORMATTING }) or {}) do
    table.insert(names, client.name)
  end
  return names
end

local function format(path)
  local out = { path = path }
  local stat = uv.fs_stat(path)
  if not stat or stat.type ~= 'file' then out.error = stat and 'not a regular file' or 'no such file'; return out end
  local buf = vim.fn.bufadd(path)
  local fresh = not api.nvim_buf_is_loaded(buf)
  vim.fn.bufload(buf)
  -- Formatting it would write those changes to the file along with the formatting.
  if vim.bo[buf].modified then out.error = "not formatted: its buffer in Pi's Neovim has unsaved changes"; return out end
  -- Asked to write one anyway, an editor with 'confirm' set stops at a dialog.
  if vim.bo[buf].readonly or vim.fn.filewritable(path) ~= 1 then out.error = 'not formatted: the file is read-only'; return out end
  -- The file on disk is what gets formatted: pick up what was written since the buffer loaded.
  local tick = api.nvim_buf_get_changedtick(buf)
  vim.bo[buf].autoread = true
  vim.cmd('silent checktime ' .. buf)
  fresh = fresh or tick ~= api.nvim_buf_get_changedtick(buf)

  local loaded, filetype = now(), vim.bo[buf].filetype
  vim.wait(left(), function()
    out.formatters = formatters(buf)
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
  local before, failure, written = read(), nil, false
  -- With the buffer current: language-server formatting asks about the current buffer,
  -- whichever one it was given.
  local ok, err = pcall(api.nvim_buf_call, buf, function()
    if has_conform then
      conform.format({ bufnr = buf, async = false, quiet = true, timeout_ms = left() }, function(e) failure = e end)
    else
      -- Not vim.lsp.buf.format: it tells the user of a server's error or silence and carries on.
      for _, client in ipairs(lsp.get_clients({ bufnr = buf, method = FORMATTING })) do
        local reply, silence = client:request_sync(FORMATTING, lsp.util.make_formatting_params(), left(), buf)
        local problem = reply and reply.err and (reply.err.message or reply.err.code) or silence
        if problem then failure = ('%s: %s'):format(client.name, problem); break end
        if type(reply.result) == 'table' then lsp.util.apply_text_edits(reply.result, buf, client.offset_encoding) end
      end
    end
    -- Checked here too: conform gives each language server the whole of the time left.
    if not failure and left() == 0 then failure = 'timeout' end
    if not failure and vim.bo[buf].modified then
      vim.cmd('silent noautocmd write')
      written = true
    end
  end)
  failure = failure or (not ok and err)
  if failure then
    -- A formatter that failed part-way must not leave a half-formatted buffer behind.
    if vim.bo[buf].modified then pcall(api.nvim_buf_call, buf, function() vim.cmd('silent keepalt keepjumps edit!') end) end
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
