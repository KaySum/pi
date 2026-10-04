-- Loaded over the private RPC socket. No user config edits or global LSP handlers.
if _G.__pi_diagnostics_v1 then return true end
local api, uv = vim.api, vim.uv or vim.loop
local M = { entries = {}, requests = {}, clock = 0 }
_G.__pi_diagnostics_v1 = M
local group = api.nvim_create_augroup('PiNvimDiagnosticsV1', { clear = true })

local function wall_ms()
  local sec, usec = uv.gettimeofday()
  return sec * 1000 + usec / 1000
end
local function valid(e)
  if not api.nvim_buf_is_valid(e.buf) then return false end
  local name = api.nvim_buf_get_name(e.buf)
  return (uv.fs_realpath(name) or name) == e.path
end
local function tracked(buf)
  for _, e in pairs(M.entries) do if e.buf == buf then return e end end
end
api.nvim_create_autocmd('DiagnosticChanged', {
  group = group,
  callback = function(ev)
    local e = tracked(ev.buf)
    if e then e.events = e.events + 1 end
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
      local removable = not valid(e) or not e.owned or not api.nvim_buf_is_loaded(e.buf)
      if not removable and not vim.bo[e.buf].modified and not vim.bo[e.buf].buflisted
          and vim.b[e.buf].pi_nvim_diagnostics_owned and #vim.fn.win_findbuf(e.buf) == 0 then
        -- Unload only our hidden, unmodified, unlisted buffers; never force/wipe.
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
  for _, f in ipairs(r.files) do
    for _, pull in pairs(f.pulls) do
      if pull.id and not pull.done then pcall(pull.client.cancel_request, pull.client, pull.id) end
    end
  end
  prune()
end

local function prepare(input, f)
  local e = M.entries[input.path]
  if e and not valid(e) then M.entries[input.path] = nil; e = nil end
  if not e then
    local buf
    for _, b in ipairs(api.nvim_list_bufs()) do
      local name = api.nvim_buf_get_name(b)
      if name ~= '' and (uv.fs_realpath(name) or name) == input.path then buf = b; break end
    end
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
  f.entry = e
  f.initialEvents = e.events
  if vim.bo[e.buf].modified then f.status = 'buffer_modified'; return end
  local loaded = api.nvim_buf_is_loaded(e.buf)
  f.refreshed = not loaded or e.hash ~= input.hash or e.tick ~= api.nvim_buf_get_changedtick(e.buf)
  if f.refreshed then
    e.refreshEvents = e.events
    if loaded then
      api.nvim_buf_call(e.buf, function()
        api.nvim_cmd({ cmd = 'edit', mods = { silent = true, keepalt = true, keepjumps = true } }, {})
      end)
    else
      vim.fn.bufload(e.buf) -- Normal BufRead/FileType events activate configured providers.
    end
    assert(api.nvim_buf_is_loaded(e.buf), 'Buffer failed to load')
    if vim.bo[e.buf].modified then f.status = 'buffer_modified'; return end
    e.hash = input.hash
    e.tick = api.nvim_buf_get_changedtick(e.buf)
  end
  f.tick = e.tick
end

function M.begin(token, inputs, deadline)
  assert(wall_ms() < deadline, 'Diagnostics deadline expired before buffer preparation')
  local r = { files = {}, deadline = deadline }
  M.requests[token] = r
  -- Bounded cleanup even if the caller disconnects before sending finish().
  r.timer = vim.defer_fn(function() M.finish(token) end, math.max(1, math.ceil(deadline - wall_ms() + 1000)))
  for _, input in ipairs(inputs) do
    local f = { path = input.path, pulls = {} }
    table.insert(r.files, f)
    if wall_ms() >= deadline then f.status = 'timed_out'
    else
      local ok, err = pcall(prepare, input, f)
      if not ok then f.status = 'file_error'; f.error = tostring(err) end
    end
  end
  return true
end

local function pull_for(r, f, client)
  if f.pulls[client.id] or not client.initialized or not client:supports_method('textDocument/diagnostic', f.entry.buf) then return end
  local pull = { client = client, done = false }
  f.pulls[client.id] = pull
  local params = { textDocument = { uri = vim.uri_from_bufnr(f.entry.buf) } }
  local capability = client.server_capabilities.diagnosticProvider
  if type(capability) == 'table' then params.identifier = capability.identifier end
  local ok, sent, id = pcall(client.request, client, 'textDocument/diagnostic', params, function(err, result, ctx)
    if M.requests[r.token] ~= r then return end
    pull.done = true
    if not valid(f.entry) or api.nvim_buf_get_changedtick(f.entry.buf) ~= f.tick then
      pull.error = 'Buffer changed during diagnostic request'
    elseif err then pull.error = tostring(err.message or err)
    elseif result then
      -- Let Neovim handle LSP character encodings, namespaces, related documents,
      -- and result IDs. Only public APIs; no replacement of publish handlers.
      local handled, message = pcall(vim.lsp.diagnostic.on_diagnostic, nil, result, ctx)
      if handled then pull.success = true else pull.error = tostring(message) end
    else pull.error = 'Empty diagnostic response' end
  end, f.entry.buf)
  if not ok or not sent then pull.done = true; pull.error = tostring(id or sent)
  else pull.id = id end
end

local severity = { 'error', 'warning', 'info', 'hint' }
local function text(value, maximum)
  if type(value) ~= 'string' and type(value) ~= 'number' then return nil end
  return tostring(value):sub(1, maximum)
end
function M.snapshot(token, include_diagnostics)
  local r = M.requests[token]
  assert(r, 'Diagnostics request expired')
  r.token = token
  local results, bytes, count = {}, 0, 0
  for _, f in ipairs(r.files) do
    local e = f.entry
    local out = { path = f.path, status = f.status, error = f.error, clients = {}, pullErrors = {}, diagnostics = {}, omittedDiagnostics = 0 }
    table.insert(results, out)
    if not f.status then
      if not valid(e) or not api.nvim_buf_is_loaded(e.buf) then out.status = 'buffer_unavailable'
      elseif vim.bo[e.buf].modified then out.status = 'buffer_modified'
      elseif api.nvim_buf_get_changedtick(e.buf) ~= f.tick then out.status = 'buffer_changed'
      else
        out.refreshed = f.refreshed
        out.changedtick = f.tick
        out.eventsSinceRequest = e.events - f.initialEvents
        out.eventsSinceRefresh = e.events - e.refreshEvents
        out.pendingPulls, out.completedPulls = 0, 0
        for _, client in ipairs(vim.lsp.get_clients({ bufnr = e.buf })) do
          table.insert(out.clients, { name = text(client.name, 512) or 'unknown', id = client.id,
            root = text(client.config.root_dir, 4096), initialized = client.initialized == true })
          pull_for(r, f, client)
        end
        table.sort(out.clients, function(a, b) return a.id < b.id end)
        for _, pull in pairs(f.pulls) do
          if not pull.done then out.pendingPulls = out.pendingPulls + 1
          elseif pull.success then out.completedPulls = out.completedPulls + 1
          elseif pull.error then table.insert(out.pullErrors, { client = pull.client.name, error = pull.error }) end
        end
        out.observed = out.eventsSinceRefresh > 0 or out.completedPulls > 0
        if include_diagnostics then
          for _, d in ipairs(vim.diagnostic.get(e.buf)) do
            local message = text(d.message, 8192) or ''
            local cost = #message + 2048
            if count >= 10000 or bytes + cost > 8 * 1024 * 1024 then
              out.omittedDiagnostics = out.omittedDiagnostics + 1
            else
              count = count + 1; bytes = bytes + cost
              local namespace = d.namespace and vim.diagnostic.get_namespace(d.namespace)
              table.insert(out.diagnostics, {
                severity = severity[d.severity] or 'error', message = message,
                messageTruncated = type(d.message) == 'string' and #d.message > 8192,
                source = text(d.source, 512), code = text(d.code, 256),
                namespace = namespace and text(namespace.name, 512),
                line = d.lnum + 1, column = d.col + 1,
                endLine = d.end_lnum + 1, endColumn = d.end_col + 1,
              })
            end
          end
        end
      end
    end
  end
  return results
end

function M.dispose()
  local tokens = vim.tbl_keys(M.requests)
  for _, token in ipairs(tokens) do M.finish(token) end
  api.nvim_del_augroup_by_id(group)
  _G.__pi_diagnostics_v1 = nil
end
return true
