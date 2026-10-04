-- Shared disk-buffer cache and request leases for all read-only Pi consumers.
if _G.__pi_nvim_buffers_v1 then return true end
local api, uv = vim.api, vim.uv or vim.loop
local M = { entries = {}, requests = {}, clock = 0 }
_G.__pi_nvim_buffers_v1 = M
function M.wall_ms()
  local sec, usec = uv.gettimeofday()
  return sec * 1000 + usec / 1000
end
function M.valid(e)
  if not e or not api.nvim_buf_is_valid(e.buf) then return false end
  local name = api.nvim_buf_get_name(e.buf)
  return (uv.fs_realpath(name) or name) == e.path
end
local function find(path)
  for _, b in ipairs(api.nvim_list_bufs()) do
    local name = api.nvim_buf_get_name(b)
    if name ~= '' and (uv.fs_realpath(name) or name) == path then return b end
  end
end
api.nvim_create_autocmd('DiagnosticChanged', {
  group = api.nvim_create_augroup('PiNvimBuffersV1', { clear = true }),
  callback = function(ev)
    for _, e in pairs(M.entries) do if e.buf == ev.buf then e.events = e.events + 1; break end end
  end,
})
local function prune()
  local protected, entries = {}, {}
  for _, r in pairs(M.requests) do
    for _, f in ipairs(r.files) do if f.entry then protected[f.entry] = true end end
  end
  for _, e in pairs(M.entries) do table.insert(entries, e) end
  table.sort(entries, function(a, b) return a.used < b.used end)
  local remaining = #entries
  for _, e in ipairs(entries) do
    if remaining <= 128 then break end
    if not protected[e] then
      local removable = not M.valid(e) or not e.owned or not api.nvim_buf_is_loaded(e.buf)
      if not removable and not vim.bo[e.buf].modified and not vim.bo[e.buf].buflisted
          and vim.b[e.buf].pi_nvim_diagnostics_owned and #vim.fn.win_findbuf(e.buf) == 0 then
        removable = pcall(api.nvim_buf_delete, e.buf, { unload = true })
      end
      if removable then M.entries[e.path] = nil; remaining = remaining - 1 end
    end
  end
end
function M.finish(token)
  local r = M.requests[token]
  if not r then return end
  M.requests[token] = nil
  if r.timer and not r.timer:is_closing() then r.timer:stop(); r.timer:close() end
  if r.on_finish then pcall(r.on_finish) end
  prune()
end
local function prepare(input, f)
  local e = M.entries[input.path]
  if e and not M.valid(e) then M.entries[input.path] = nil; e = nil end
  if not e then
    local buf = find(input.path)
    -- Keep the historical ownership marker for compatibility with adopters.
    local owned = not buf or vim.b[buf].pi_nvim_diagnostics_owned == true
    buf = buf or vim.fn.bufadd(input.path)
    assert(buf > 0, 'Cannot create buffer')
    e = { path = input.path, buf = buf, owned = owned, events = 0, refreshEvents = 0, used = 0 }
    M.entries[input.path] = e
    if owned then
      vim.b[buf].pi_nvim_diagnostics_owned = true
      vim.bo[buf].swapfile = false
      vim.bo[buf].modeline = false
    end
  end
  M.clock = M.clock + 1; e.used = M.clock
  f.entry = e; f.initialEvents = e.events
  if vim.bo[e.buf].modified then f.status = 'buffer_modified'; return end
  local loaded = api.nvim_buf_is_loaded(e.buf)
  f.refreshed = not loaded or e.hash ~= input.hash or e.tick ~= api.nvim_buf_get_changedtick(e.buf)
  if f.refreshed then
    e.refreshEvents = e.events
    if loaded then
      api.nvim_buf_call(e.buf, function()
        api.nvim_cmd({ cmd = 'edit', mods = { silent = true, keepalt = true, keepjumps = true } }, {})
      end)
    else vim.fn.bufload(e.buf) end
    assert(api.nvim_buf_is_loaded(e.buf), 'Buffer failed to load')
    if vim.bo[e.buf].modified then f.status = 'buffer_modified'; return end
    e.hash = input.hash; e.tick = api.nvim_buf_get_changedtick(e.buf)
  end
  f.tick = e.tick
end
function M.begin(token, inputs, deadline)
  assert(M.wall_ms() < deadline, 'Neovim deadline expired before buffer preparation')
  assert(not M.requests[token], 'Duplicate request token')
  local r = { files = {}, deadline = deadline }
  M.requests[token] = r
  r.timer = vim.defer_fn(function() M.finish(token) end, math.max(1, math.ceil(deadline - M.wall_ms() + 1000)))
  for _, input in ipairs(inputs) do
    local f = { path = input.path }
    table.insert(r.files, f)
    if M.wall_ms() >= deadline then f.status = 'timed_out'
    else
      local ok, err = pcall(prepare, input, f)
      if not ok then f.status = 'file_error'; f.error = tostring(err) end
    end
  end
  return r
end
function M.state(f)
  if f.status then return f.status end
  if not M.valid(f.entry) or not api.nvim_buf_is_loaded(f.entry.buf) then return 'buffer_unavailable' end
  if vim.bo[f.entry.buf].modified then return 'buffer_modified' end
  if api.nvim_buf_get_changedtick(f.entry.buf) ~= f.tick then return 'buffer_changed' end
end
-- Do not load target files: only inspect already-existing buffers.
function M.inspect(paths)
  local results = {}
  for _, path in ipairs(paths) do
    local buf, e = find(path), M.entries[path]
    local out = { path = path, loaded = buf ~= nil and api.nvim_buf_is_loaded(buf) }
    if out.loaded then
      out.modified = vim.bo[buf].modified
      out.hash = e and M.valid(e) and e.tick == api.nvim_buf_get_changedtick(buf) and e.hash or nil
      out.fileformat = vim.bo[buf].fileformat
      out.fileencoding = vim.bo[buf].fileencoding
    end
    table.insert(results, out)
  end
  return results
end
return true
