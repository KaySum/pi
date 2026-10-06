-- Diagnostic-specific requests; buffers, revisions and leases are service-shared.
if _G.__pi_diagnostics_v1 then return true end
local B = assert(_G.__pi_nvim_buffers_v1)
local M = { entries = B.entries, requests = {} }
_G.__pi_diagnostics_v1 = M
local group = vim.api.nvim_create_augroup('PiNvimDiagnosticsV1', { clear = true })
local MAX_PULL_ATTEMPTS = 3
-- Neovim consumes RequestCancelled acknowledgements without calling the response
-- handler. Observe completion too, but defer until the normal handler has run.
vim.api.nvim_create_autocmd('LspRequest', {
  group = group,
  callback = function(ev)
    local data = ev.data or {}
    if not data.request or data.request.method ~= 'textDocument/diagnostic' or data.request.type ~= 'complete' then return end
    for _, r in pairs(M.requests) do
      for _, f in ipairs(r.files) do
        local pull = f.pulls[data.client_id]
        if pull and pull.id == data.request_id and not pull.done then
          vim.schedule(function()
            if M.requests[r.token] == r and f.pulls[data.client_id] == pull and not pull.done then
              pull.done = true
              pull.retryable = true
              pull.error = 'Diagnostic request ended without a response callback (cancelled or superseded)'
            end
          end)
        end
      end
    end
  end,
})
function M.finish(token) B.finish(token) end
function M.begin(token, inputs, deadline)
  local r = B.begin(token, inputs, deadline)
  r.token = token
  M.requests[token] = r
  for _, f in ipairs(r.files) do f.pulls = {} end
  r.on_finish = function()
    M.requests[token] = nil
    for _, f in ipairs(r.files) do
      for _, pull in pairs(f.pulls) do
        if pull.id and not pull.done then pcall(pull.client.cancel_request, pull.client, pull.id) end
      end
    end
  end
  return true
end
local function pull_for(r, f, client)
  local previous = f.pulls[client.id]
  if previous and not (previous.done and previous.retryable and previous.attempts < MAX_PULL_ATTEMPTS) then return end
  if not client.initialized or not client:supports_method('textDocument/diagnostic', f.entry.buf) then return end
  local pull = { client = client, done = false, attempts = previous and previous.attempts + 1 or 1 }
  f.pulls[client.id] = pull
  local params = { textDocument = { uri = vim.uri_from_bufnr(f.entry.buf) } }
  local capability = client.server_capabilities.diagnosticProvider
  if type(capability) == 'table' then params.identifier = capability.identifier end
  local ok, sent, id = pcall(client.request, client, 'textDocument/diagnostic', params, function(err, result, ctx)
    if M.requests[r.token] ~= r or f.pulls[client.id] ~= pull then return end
    pull.done = true
    if B.state(f) then pull.error = 'Buffer changed during diagnostic request'
    elseif err then pull.error = tostring(err.message or err)
    elseif result then
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
  local r = assert(M.requests[token], 'Diagnostics request expired')
  local results, bytes, count = {}, 0, 0
  for _, f in ipairs(r.files) do
    local e = f.entry
    local out = { path = f.path, status = B.state(f), error = f.error, clients = {}, pullErrors = {}, diagnostics = {}, omittedDiagnostics = 0 }
    table.insert(results, out)
    if not out.status then
      out.refreshed = f.refreshed
      out.changedtick = f.tick
      out.eventsSinceRequest = e.events - f.initialEvents
      out.eventsSinceRefresh = e.events - e.refreshEvents
      out.pendingPulls, out.completedPulls, out.pullRetries = 0, 0, 0
      out.pendingPullClients = {}
      for _, client in ipairs(vim.lsp.get_clients({ bufnr = e.buf })) do
        table.insert(out.clients, { name = text(client.name, 512) or 'unknown', id = client.id,
          root = text(client.config.root_dir, 4096), initialized = client.initialized == true })
        pull_for(r, f, client)
      end
      table.sort(out.clients, function(a, b) return a.id < b.id end)
      for _, pull in pairs(f.pulls) do
        out.pullRetries = out.pullRetries + pull.attempts - 1
        if not pull.done then
          out.pendingPulls = out.pendingPulls + 1
          table.insert(out.pendingPullClients, text(pull.client.name, 512) or 'unknown')
        elseif pull.success then out.completedPulls = out.completedPulls + 1
        elseif pull.error then table.insert(out.pullErrors, { client = pull.client.name, error = pull.error }) end
      end
      table.sort(out.pendingPullClients)
      out.observed = out.eventsSinceRefresh > 0 or out.completedPulls > 0
      if include_diagnostics then
        for _, d in ipairs(vim.diagnostic.get(e.buf)) do
          local message = text(d.message, 8192) or ''
          local cost = #message + 2048
          if count >= 10000 or bytes + cost > 8 * 1024 * 1024 then out.omittedDiagnostics = out.omittedDiagnostics + 1
          else
            count = count + 1; bytes = bytes + cost
            local namespace = d.namespace and vim.diagnostic.get_namespace(d.namespace)
            table.insert(out.diagnostics, {
              severity = severity[d.severity] or 'error', message = message,
              messageTruncated = type(d.message) == 'string' and #d.message > 8192,
              source = text(d.source, 512), code = text(d.code, 256), namespace = namespace and text(namespace.name, 512),
              line = d.lnum + 1, column = d.col + 1, endLine = d.end_lnum + 1, endColumn = d.end_col + 1,
            })
          end
        end
      end
    end
  end
  return results
end
function M.dispose()
  for _, token in ipairs(vim.tbl_keys(M.requests)) do M.finish(token) end
  vim.api.nvim_del_augroup_by_id(group)
  _G.__pi_diagnostics_v1 = nil
end
return true
