-- Diagnostic-specific requests; buffers, revisions and leases are service-shared.
if _G.__pi_diagnostics_v1 then return true end
local B = assert(_G.__pi_nvim_buffers_v1)
local M = { entries = B.entries, requests = {} }
_G.__pi_diagnostics_v1 = M
local group = vim.api.nvim_create_augroup('PiNvimDiagnosticsV1', { clear = true })
local MAX_PULL_ATTEMPTS, MAX_PULL_PROVIDERS = 3, 16
-- Neovim consumes RequestCancelled acknowledgements without calling the response
-- handler. Observe completion too, but defer until the normal handler has run.
vim.api.nvim_create_autocmd('LspRequest', {
  group = group,
  callback = function(ev)
    local data = ev.data or {}
    if not data.request or data.request.method ~= 'textDocument/diagnostic' or data.request.type ~= 'complete' then return end
    for _, r in pairs(M.requests) do
      for _, f in ipairs(r.files) do
        for key, pull in pairs(f.pulls) do
          if pull.client.id == data.client_id and pull.id == data.request_id and not pull.done then
            vim.schedule(function()
              if M.requests[r.token] == r and f.pulls[key] == pull and not pull.done then
                pull.done = true
                pull.retryable = true
                pull.error = 'Diagnostic request ended without a response callback (cancelled or superseded)'
              end
            end)
          end
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
  for _, f in ipairs(r.files) do f.pulls = {}; f.providerErrors = {} end
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
local function providers_for(client, buf)
  local dynamic = client.dynamic_capabilities
  local registrations
  if dynamic and type(dynamic.get) == 'function' then
    -- 0.12 exposes provider-keyed lists; 0.11 exposes one method-keyed match.
    -- Pass the anchor explicitly: the service's current buffer is unrelated.
    registrations = dynamic:get('diagnosticProvider', { bufnr = buf })
      or dynamic:get('textDocument/diagnostic', { bufnr = buf })
  end
  local providers, seen = {}, {}
  local function add(capability)
    local identifier
    if type(capability) == 'table' then identifier = capability.identifier end
    if identifier == vim.NIL then identifier = nil end
    assert(identifier == nil or type(identifier) == 'string', 'Invalid diagnostic provider identifier')
    local key = client.id .. ':' .. (identifier == nil and 'default' or 'id:' .. identifier)
    if not seen[key] then
      assert(#providers < MAX_PULL_PROVIDERS, 'Diagnostic provider limit exceeded (16 per client/file/call)')
      seen[key] = true
      table.insert(providers, { key = key, identifier = identifier })
    end
  end
  if registrations then
    if registrations.method then registrations = { registrations } end
    for _, registration in ipairs(registrations) do add(registration.registerOptions) end
  else
    local capability = client.server_capabilities.diagnosticProvider
    assert(capability, 'Diagnostic provider registration unavailable; refusing to guess an identifier')
    add(capability)
  end
  assert(#providers > 0, 'Diagnostic provider registration unavailable')
  return providers
end
local function pull_for(r, f, client, provider)
  local key, identifier = provider.key, provider.identifier
  local previous = f.pulls[key]
  if previous and not (previous.done and previous.retryable and previous.attempts < MAX_PULL_ATTEMPTS) then return end
  local pull = { client = client, identifier = identifier, done = false, attempts = previous and previous.attempts + 1 or 1 }
  f.pulls[key] = pull
  local params = { textDocument = { uri = vim.uri_from_bufnr(f.entry.buf) }, identifier = identifier }
  local ok, sent, id = pcall(client.request, client, 'textDocument/diagnostic', params, function(err, result, ctx)
    if M.requests[r.token] ~= r or f.pulls[key] ~= pull then return end
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
local function pulls_for(r, f, client)
  if not client.initialized or not client:supports_method('textDocument/diagnostic', f.entry.buf) then return end
  local ok, providers = pcall(providers_for, client, f.entry.buf)
  f.providerErrors[client.id] = nil
  if not ok then f.providerErrors[client.id] = { client = client.name, error = tostring(providers) }; return end
  local count = 0
  for _, pull in pairs(f.pulls) do if pull.client.id == client.id then count = count + 1 end end
  for _, provider in ipairs(providers) do
    if not f.pulls[provider.key] then
      if count >= MAX_PULL_PROVIDERS then
        f.providerErrors[client.id] = { client = client.name, error = 'Diagnostic provider limit exceeded (16 per client/file/call)' }
        break
      end
      count = count + 1
    end
    pull_for(r, f, client, provider)
  end
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
        pulls_for(r, f, client)
      end
      table.sort(out.clients, function(a, b) return a.id < b.id end)
      local pending = {}
      for _, pull in pairs(f.pulls) do
        out.pullRetries = out.pullRetries + pull.attempts - 1
        if not pull.done then
          out.pendingPulls = out.pendingPulls + 1
          pending[text(pull.client.name, 512) or 'unknown'] = true
        elseif pull.success then out.completedPulls = out.completedPulls + 1
        elseif pull.error then table.insert(out.pullErrors, {
          client = text(pull.client.name, 512), identifier = text(pull.identifier, 512), error = text(pull.error, 8192),
        }) end
      end
      for _, err in pairs(f.providerErrors) do
        table.insert(out.pullErrors, { client = text(err.client, 512), error = text(err.error, 8192) })
      end
      out.pendingPullClients = vim.tbl_keys(pending)
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
