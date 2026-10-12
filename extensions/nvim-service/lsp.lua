-- For extensions that have language servers change files: when a file's servers have
-- attached, and how to ask one without getting an answer about some older text.
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local now = function() return uv.hrtime() / 1e6 end
-- A client may be created a moment after a buffer loads; much later on a filetype's first use.
local ATTACH_MS, FIRST_ATTACH_MS = 300, 2000
-- A server showing progress is loading, and may answer about the files as they were before:
-- rust-analyzer takes in no changes while it scans a project, and edits made for an older
-- text ruin this one. So a server is only asked once it has shown no progress for this
-- long, and its answer is dropped if it showed any before the answer came.
local CALM_MS = 500
-- Errors that say the server's state changed under the request: ContentModified, ServerCancelled.
local TRANSIENT = { [-32801] = true, [-32802] = true }

-- Remembered for the life of this Neovim: the file types seen, and when each language
-- server last reported progress.
local S = _G.__pi_nvim_lsp_v1
if not S then
  S = { filetypes = {}, progress = {} }
  _G.__pi_nvim_lsp_v1 = S
  api.nvim_create_autocmd('LspProgress', {
    group = api.nvim_create_augroup('PiNvimLsp', {}),
    callback = function(ev) S.progress[ev.data.client_id] = uv.hrtime() / 1e6 end,
  })
end

local M = {}

-- True once no more servers are to be expected for the buffer and those it has are running.
-- `loaded` is when it was (re)loaded, if that was only just now.
function M.attached(buf, loaded)
  local clients = lsp.get_clients({ bufnr = buf, _uninitialized = true })
  for _, client in ipairs(clients) do
    if not client.initialized then return false end
  end
  return #clients > 0 or not loaded or now() - loaded >= (S.filetypes[vim.bo[buf].filetype] and ATTACH_MS or FIRST_ATTACH_MS)
end

-- To be called once a buffer's servers have been waited for: the next file of its type is
-- not given as long.
function M.seen(buf) S.filetypes[vim.bo[buf].filetype] = true end

-- Tell a buffer's servers that it was written, which a write without autocommands does
-- not. Some only then look again at what depends on the file: clangd reads the headers a
-- source includes from disk, and goes on using the old ones until it hears of a save.
function M.saved(buf)
  for _, client in ipairs(lsp.get_clients({ bufnr = buf, method = 'textDocument/didSave' })) do
    local sync = client.server_capabilities.textDocumentSync
    local text = type(sync) == 'table' and type(sync.save) == 'table' and sync.save.includeText
      and table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), '\n') .. '\n' or nil
    client:notify('textDocument/didSave', { textDocument = { uri = vim.uri_from_bufnr(buf) }, text = text })
  end
end

-- Ask one server, within `ms`: its answer, or nil, what went wrong and whether asking
-- again may help.
function M.ask(client, method, params, buf, ms)
  local deadline = now() + ms
  local left = function() return math.max(0, deadline - now()) end
  -- What a server did before it was first seen here is unknown, so it starts out as busy.
  S.progress[client.id] = S.progress[client.id] or now()
  local busy = function() return next(client.progress.pending) ~= nil end
  if not vim.wait(left(), function() return not busy() and now() - S.progress[client.id] >= CALM_MS end, 20) then
    return nil, client.name .. ': timeout while it was loading'
  end
  -- Neovim holds back the changes to a buffer for a moment, and a request only sends on
  -- those of the buffer it is about: a server asked about a project needs them all.
  if lsp._changetracking then lsp._changetracking.flush(client) end
  local asked = now()
  -- A server that a plugin runs inside Neovim fails by raising an error (crates.nvim).
  local ok, reply, silence = pcall(client.request_sync, client, method, params, left(), buf)
  if not ok then return nil, ('%s: %s'):format(client.name, vim.trim(tostring(reply):gsub('\nstack traceback:.*', '')):gsub('%s+', ' '):sub(1, 300)) end
  local moved = busy() or S.progress[client.id] >= asked
  local err = reply and reply.err
  if err then return nil, ('%s: %s'):format(client.name, err.message or err.code), TRANSIENT[err.code] or moved end
  if not reply then return nil, ('%s: %s'):format(client.name, silence) end
  if moved then return nil, client.name .. ' began loading while it was asked', true end
  -- A server inside Neovim hands over its nulls as they are.
  if reply.result ~= vim.NIL then return reply.result end
end

return M
