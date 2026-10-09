-- Request-scoped diagnostics. Shared buffers/leases stay in nvim-service.
if _G.__pi_diagnostics_v1 then return true end
local B = assert(_G.__pi_nvim_buffers_v1)
local api = vim.api
local M = { entries = B.entries, requests = {}, protocolVersion = 2 }
_G.__pi_diagnostics_v1 = M
local group = api.nvim_create_augroup('PiNvimDiagnosticsV1', { clear = true })
local MAX_ATTEMPTS, MAX_PROVIDERS, MAX_CLIENTS = 3, 16, 16
local MAX_RECORDS, MAX_BYTES = 10000, 8 * 1024 * 1024
local severity = { 'error', 'warning', 'info', 'hint' }
local function text(value, maximum)
  if type(value) ~= 'string' and type(value) ~= 'number' then return nil end
  return tostring(value):sub(1, maximum)
end
local function elapsed(r) return math.max(0, math.floor(B.wall_ms() - r.startedAt)) end
local function pull_state(p)
  if p.retired then return 'retired' end
  if not p.done or (p.retryable and p.attempts < MAX_ATTEMPTS) then return 'pending' end
  return p.success and 'responded' or 'error'
end
-- RequestCancelled replies can skip the response handler. Defer completion
-- bookkeeping so an ordinary scheduled response handler always gets first use.
api.nvim_create_autocmd('LspRequest', {
  group = group,
  callback = function(ev)
    local data = ev.data or {}
    if not data.request or data.request.method ~= 'textDocument/diagnostic' or data.request.type ~= 'complete' then return end
    for _, r in pairs(M.requests) do
      for _, f in ipairs(r.files) do
        for key, p in pairs(f.pulls) do
          if p.client.id == data.client_id and p.id == data.request_id and not p.done then
            vim.schedule(function()
              if M.requests[r.token] == r and f.pulls[key] == p and not p.done then
                p.done, p.retryable, p.completedAtMs = true, true, elapsed(r)
                p.error = 'Diagnostic request ended without a response callback (cancelled or superseded)'
              end
            end)
          end
        end
      end
    end
  end,
})
function M.finish(token) B.finish(token) end
function M.begin(token, inputs, deadline, options)
  options = options or {}
  local r = B.begin(token, inputs, deadline)
  r.token, r.mode, r.required = token, options.mode or 'snapshot', {}
  r.names, r.startedAt = options.requiredClients or {}, options.startedAt or B.wall_ms()
  r.records, r.bytes, r.registrationCounter = 0, 0, 0
  r.registrationIds = setmetatable({}, { __mode = 'k' })
  for _, name in ipairs(r.names) do r.required[name] = true end
  M.requests[token] = r
  r.on_finish = function()
    M.requests[token] = nil
    for _, f in ipairs(r.files) do
      for _, p in pairs(f.pulls or {}) do
        if p.id and not p.done then pcall(p.client.cancel_request, p.client, p.id) end
      end
    end
  end
  for i, f in ipairs(r.files) do
    f.pulls, f.ledger, f.sourceHash = {}, {}, inputs[i].hash
    if r.mode == 'check' and not B.state(f) then
      -- Compare logical lines, normalizing BOM/CRLF and the terminal line ending
      -- in Node before hashing. Do not trust a disk hash to describe a transformed
      -- BufReadCmd/decoding result merely because 'modified' is false.
      local size = api.nvim_buf_get_offset(f.entry.buf, api.nvim_buf_line_count(f.entry.buf))
      local actual = size <= 2 * 1024 * 1024 + 1
        and vim.fn.sha256(table.concat(api.nvim_buf_get_lines(f.entry.buf, 0, -1, false), '\n')) or nil
      if actual ~= inputs[i].bufferHash then
        f.status, f.error = 'buffer_changed', 'Neovim logical buffer contents differ from the bounded disk snapshot'
      end
    end
  end
  return true
end
local function providers_for(client, buf, r)
  local dynamic, registrations = client.dynamic_capabilities, nil
  if dynamic and type(dynamic.get) == 'function' then
    registrations = dynamic:get('diagnosticProvider', { bufnr = buf })
      or dynamic:get('textDocument/diagnostic', { bufnr = buf })
  end
  local providers, seen, enumeration = {}, {}, 'static'
  local function add(capability, registration)
    local identifier
    if type(capability) == 'table' then identifier = capability.identifier end
    if identifier == vim.NIL then identifier = nil end
    assert(identifier == nil or type(identifier) == 'string', 'Invalid diagnostic provider identifier')
    assert(identifier == nil or #identifier <= 512, 'Diagnostic provider identifier exceeds 512 bytes')
    local key = client.id .. ':' .. (identifier == nil and 'default' or 'id:' .. identifier)
    if not seen[key] then
      assert(#providers < MAX_PROVIDERS, 'Diagnostic provider limit exceeded (16 per client/file/call)')
      seen[key] = { key = key, identifier = identifier, registrations = {} }
      table.insert(providers, seen[key])
    end
    -- Public accessors return the registered objects. Use request-local weak
    -- identity tokens, not tostring(table): a freed Lua address can be reused.
    local origin = registration or capability
    if not r.registrationIds[origin] then
      r.registrationCounter = r.registrationCounter + 1
      r.registrationIds[origin] = r.registrationCounter
    end
    table.insert(seen[key].registrations, r.registrationIds[origin])
  end
  if registrations then
    enumeration = registrations.method and 'single_match' or 'matching_registrations'
    if registrations.method then registrations = { registrations } end
    assert(#registrations <= 128, 'Diagnostic registration limit exceeded (128 matching registrations)')
    for _, registration in ipairs(registrations) do add(registration.registerOptions, registration) end
  else
    local capability = client.server_capabilities.diagnosticProvider
    assert(capability, 'Diagnostic provider registration unavailable; refusing to guess an identifier')
    add(capability)
  end
  assert(#providers > 0, 'Diagnostic provider registration unavailable')
  for _, provider in ipairs(providers) do
    table.sort(provider.registrations)
    provider.registrationKey = table.concat(provider.registrations, '|')
  end
  return providers, enumeration
end
local function retire(p)
  if p.retired then return end
  p.retired = true
  if p.id and not p.done then pcall(p.client.cancel_request, p.client, p.id) end
  p.done = true
end
local function raw_range(value)
  if type(value) ~= 'table' or type(value.start) ~= 'table' or type(value['end']) ~= 'table' then return nil end
  local function position(p)
    return { line = type(p.line) == 'number' and p.line or nil,
      character = type(p.character) == 'number' and p.character or nil }
  end
  return { start = position(value.start), ['end'] = position(value['end']) }
end
local function retain_reply(r, p, result)
  p.responseKind = type(result) == 'table' and text(result.kind, 32) or nil
  if p.responseKind ~= 'full' or type(result.items) ~= 'table' or not vim.islist(result.items) then
    p.error = p.responseKind == 'unchanged' and 'Unchanged diagnostic response has no verified baseline'
      or 'Expected a full document diagnostic response with an items array'
    return
  end
  p.raw, p.responseCount, p.omittedDiagnostics = {}, #result.items, 0
  for i, item in ipairs(result.items) do
    local d = type(item) == 'table' and item or {}
    local message = text(d.message, 8192) or ''
    local cost = #message + 2048
    if r.records >= MAX_RECORDS or r.bytes + cost > MAX_BYTES then
      p.omittedDiagnostics = #result.items - i + 1
      p.error = 'Diagnostic response exceeds the collection limit'
      break
    end
    r.records, r.bytes = r.records + 1, r.bytes + cost
    table.insert(p.raw, {
      lspRange = raw_range(d.range), severity = severity[d.severity or 1] or 'error',
      malformed = type(d.message) ~= 'string' or (d.severity ~= nil and not severity[d.severity]),
      message = message, messageTruncated = type(d.message) == 'string' and #d.message > 8192,
      source = text(d.source, 512), code = text(d.code, 256),
      clientId = p.client.id, clientName = text(p.client.name, 512), identifier = p.identifier or vim.NIL,
      encoding = p.client.offset_encoding, evidence = 'owned_full_response',
    })
  end
  p.success = p.error == nil
end
local function pull_for(r, f, client, provider)
  local key, previous = provider.key, f.pulls[provider.key]
  if previous and previous.registrationKey ~= provider.registrationKey then retire(previous) end
  if previous and not previous.retired and not (previous.done and previous.retryable and previous.attempts < MAX_ATTEMPTS) then return end
  if previous and previous.attempts >= MAX_ATTEMPTS then
    -- Replace the object as well as its registration identity. A delayed callback
    -- from the retired request must not turn this budget failure into success.
    f.pulls[key] = { client = client, identifier = provider.identifier, done = true, attempts = previous.attempts,
      registrationKey = provider.registrationKey, sourceTick = f.tick,
      error = 'Diagnostic provider changed repeatedly; request attempt limit exhausted' }
    return
  end
  local p = { client = client, identifier = provider.identifier, done = false,
    attempts = previous and previous.attempts + 1 or 1, startedAtMs = elapsed(r), sourceTick = f.tick,
    registrationKey = provider.registrationKey }
  f.pulls[key] = p
  local params = { textDocument = { uri = vim.uri_from_bufnr(f.entry.buf) }, identifier = provider.identifier }
  local ok, sent, id = pcall(client.request, client, 'textDocument/diagnostic', params, function(err, result, ctx)
    if M.requests[r.token] ~= r or f.pulls[key] ~= p or p.retired then return end
    p.done, p.completedAtMs, p.documentVersion = true, elapsed(r), ctx and ctx.version
    if B.state(f) then p.error = 'Buffer changed during diagnostic request'
    elseif err then p.error = tostring(type(err) == 'table' and err.message or err)
    elseif r.mode == 'check' then retain_reply(r, p, result)
    elseif result then
      if type(result) == 'table' then
        p.responseKind = text(result.kind, 32)
        p.responseCount = type(result.items) == 'table' and #result.items or nil
      end
      local handled, message = pcall(vim.lsp.diagnostic.on_diagnostic, nil, result, ctx)
      if handled then p.success = true else p.error = tostring(message) end
    else p.error = 'Empty diagnostic response' end
  end, f.entry.buf)
  if not ok or not sent then p.done = true; p.error = tostring(id or sent); p.completedAtMs = elapsed(r)
  else p.id = id end
end
local function observe(r, f, allow_start)
  for _, c in pairs(f.ledger) do c.active = false end
  local clients = vim.lsp.get_clients({ bufnr = f.entry.buf })
  table.sort(clients, function(a, b)
    if (r.required[a.name] == true) ~= (r.required[b.name] == true) then return r.required[a.name] == true end
    return a.id < b.id
  end)
  f.extraClients, f.omittedRequired = 0, {}
  for _, client in ipairs(clients) do
    local c = f.ledger[client.id]
    if not c and vim.tbl_count(f.ledger) < MAX_CLIENTS then
      c = { client = client, firstSeenMs = elapsed(r) }; f.ledger[client.id] = c
    end
    if not c then
      f.extraClients = f.extraClients + 1
      if r.required[client.name] then f.omittedRequired[client.name] = true end
    else
      c.active, c.required, c.expected, c.error, c.enumeration = true, r.required[client.name] == true, {}, nil, nil
      c.errorFromPull = false
      c.initialized, c.name = client.initialized == true, client.name
      local requested = r.mode == 'snapshot' or c.required
      if not requested then c.state = 'not_requested'
      elseif not c.initialized then c.state = 'initializing'
      else
        local ok, supported = pcall(client.supports_method, client, 'textDocument/diagnostic', f.entry.buf)
        if not ok then c.error = tostring(supported)
        elseif not supported then c.state = 'unconfirmed'
        else
          local resolved, providers, enumeration = pcall(providers_for, client, f.entry.buf, r)
          if not resolved then c.error = tostring(providers)
          else
            c.enumeration = enumeration
            local count = 0
            for _, p in pairs(f.pulls) do if p.client.id == client.id then count = count + 1 end end
            for _, provider in ipairs(providers) do
              c.expected[provider.key] = provider
              local previous = f.pulls[provider.key]
              if previous and previous.registrationKey ~= provider.registrationKey then retire(previous) end
              if previous and previous.retired and previous.attempts >= MAX_ATTEMPTS then
                pull_for(r, f, client, provider) -- Records terminal exhaustion; never starts another request.
              end
              if not f.pulls[provider.key] then
                if count >= MAX_PROVIDERS then c.error = 'Diagnostic provider limit exceeded (16 per client/file/call)'; break end
                count = count + 1
              end
              if allow_start and B.wall_ms() < r.deadline then pull_for(r, f, client, provider) end
            end
            c.state = enumeration == 'single_match' and r.mode == 'check' and 'unconfirmed' or 'responded'
            for key in pairs(c.expected) do
              local p = f.pulls[key]
              if not p or pull_state(p) == 'pending' or p.retired then
                if c.state ~= 'unconfirmed' then c.state = 'pending' end
              elseif pull_state(p) == 'error' and not c.error then c.error, c.errorFromPull = p.error, true end
            end
          end
        end
        if c.error then c.state = 'error' end
      end
    end
  end
  for _, c in pairs(f.ledger) do
    if not c.active then c.state = 'detached'; c.expected = {} end
  end
  for key, p in pairs(f.pulls) do
    local c = f.ledger[p.client.id]
    if not c or not c.active or not c.expected[key] then retire(p) end
  end
end
local function snapshot_diag(d)
  local namespace = d.namespace and vim.diagnostic.get_namespace(d.namespace)
  return { severity = severity[d.severity] or 'error', message = text(d.message, 8192) or '',
    messageTruncated = type(d.message) == 'string' and #d.message > 8192,
    source = text(d.source, 512), code = text(d.code, 256), namespace = namespace and text(namespace.name, 512),
    line = d.lnum + 1, column = d.col + 1, endLine = (d.end_lnum or d.lnum) + 1, endColumn = (d.end_col or d.col) + 1,
    evidence = 'diagnostic_cache' }
end
function M.snapshot(token, include_diagnostics, allow_start)
  local r = assert(M.requests[token], 'Diagnostics request expired')
  local results, bytes, count = {}, 0, 0
  for _, f in ipairs(r.files) do
    local out = { path = f.path, status = B.state(f), error = f.error, clients = {}, providers = {}, requirements = {},
      pullErrors = {}, diagnostics = {}, omittedDiagnostics = 0, sourceHash = f.sourceHash }
    table.insert(results, out)
    out.providerObservationCurrent = not out.status
    if not out.status then observe(r, f, allow_start ~= false) end
    -- Preserve already-observed work and owned replies on source conflicts.
    -- Do not refresh providers or read an unrelated current cache in that case.
    if f.entry then
      out.refreshed, out.changedtick = f.refreshed, f.tick
      out.eventsSinceRequest, out.eventsSinceRefresh = f.entry.events - f.initialEvents, f.entry.events - f.entry.refreshEvents
      out.pendingPulls, out.completedPulls, out.pullRetries = 0, 0, 0
      out.extraClients = f.extraClients or 0
      local pending = {}
      for _, c in pairs(f.ledger) do
        local row = { id = c.client.id, name = text(c.name, 512), root = text(c.client.config.root_dir, 4096),
          initialized = c.initialized, attached = c.active, required = c.required, firstSeenMs = c.firstSeenMs,
          state = c.state, enumeration = c.enumeration, error = text(c.error, 8192), pulls = {} }
        table.insert(out.providers, row)
        if c.active then table.insert(out.clients, { id = row.id, name = row.name, root = row.root, initialized = row.initialized }) end
        if c.error and not c.errorFromPull then table.insert(out.pullErrors, { client = row.name, error = row.error }) end
        for key, p in pairs(f.pulls) do
          if p.client.id == c.client.id then
            out.pullRetries = out.pullRetries + p.attempts - 1
            table.insert(row.pulls, { identifier = p.identifier or vim.NIL, requestId = p.id, state = pull_state(p),
              attempts = p.attempts, startedAtMs = p.startedAtMs, completedAtMs = p.completedAtMs,
              responseKind = p.responseKind, responseCount = p.responseCount, documentVersion = p.documentVersion,
              sourceTick = p.sourceTick, error = text(p.error, 8192), omittedDiagnostics = p.omittedDiagnostics or 0 })
            if c.active and c.expected[key] and not p.retired then
              if pull_state(p) == 'pending' then out.pendingPulls = out.pendingPulls + 1; pending[row.name] = true
              elseif p.success then out.completedPulls = out.completedPulls + 1 end
              if p.error and pull_state(p) == 'error' then
                table.insert(out.pullErrors, { client = row.name, identifier = text(p.identifier, 512), error = text(p.error, 8192) })
              end
              if r.mode == 'check' then
                out.omittedDiagnostics = out.omittedDiagnostics + (p.omittedDiagnostics or 0)
                if include_diagnostics then for _, d in ipairs(p.raw or {}) do table.insert(out.diagnostics, d) end end
              end
            end
          end
        end
        for key, provider in pairs(c.expected) do
          if not f.pulls[key] then table.insert(row.pulls, {
            identifier = provider.identifier or vim.NIL, state = 'not_requested', attempts = 0,
          }) end
        end
        table.sort(row.pulls, function(a, b) return tostring(a.identifier) < tostring(b.identifier) end)
      end
      table.sort(out.clients, function(a, b) return a.id < b.id end)
      table.sort(out.providers, function(a, b) return a.id < b.id end)
      table.sort(out.pullErrors, function(a, b) return (a.client .. (a.identifier or '') .. a.error) < (b.client .. (b.identifier or '') .. b.error) end)
      out.pendingPullClients = vim.tbl_keys(pending); table.sort(out.pendingPullClients)
      out.observed = out.eventsSinceRefresh > 0 or out.completedPulls > 0
      for _, name in ipairs(r.names) do
        local req = { name = name, state = 'missing', clientIds = {} }
        local rank = { responded = 1, pending = 2, unconfirmed = 3, initializing = 4, error = 5 }
        local detached = false
        for _, c in pairs(f.ledger) do
          if c.name == name then
            if c.active then
              table.insert(req.clientIds, c.client.id)
              if req.state == 'missing' or rank[c.state] > rank[req.state] then req.state = c.state end
            else detached = true end
          end
        end
        table.sort(req.clientIds)
        if (f.omittedRequired or {})[name] then req.state, req.reason = 'failed', 'Required client observation limit exceeded'
        elseif req.state == 'error' then req.state, req.reason = 'failed', 'A required provider failed'
        elseif req.state == 'missing' and detached then req.state, req.reason = 'failed', 'Required client detached'
        elseif req.state == 'missing' then req.reason = 'Required client has not been observed on this file'
        elseif req.state == 'unconfirmed' then req.reason = 'No verifiable pull capability or complete provider enumeration'
        elseif req.state == 'initializing' then req.reason = 'Required client is initializing'
        elseif req.state == 'pending' then req.reason = 'A required provider has not answered this call' end
        table.insert(out.requirements, req)
      end
      if not out.status and include_diagnostics and r.mode == 'snapshot' then
        for _, d in ipairs(vim.diagnostic.get(f.entry.buf)) do
          local record = snapshot_diag(d)
          local cost = #record.message + 2048
          if count >= MAX_RECORDS or bytes + cost > MAX_BYTES then out.omittedDiagnostics = out.omittedDiagnostics + 1
          else count = count + 1; bytes = bytes + cost; table.insert(out.diagnostics, record) end
        end
      end
    end
  end
  return results
end
-- A separate final boundary makes it explicit that no new work starts while
-- checking buffer revisions and the currently observed registration set.
function M.verify(token) return M.snapshot(token, true, false) end
function M.dispose()
  for _, token in ipairs(vim.tbl_keys(M.requests)) do M.finish(token) end
  api.nvim_del_augroup_by_id(group)
  _G.__pi_diagnostics_v1 = nil
end
return true
