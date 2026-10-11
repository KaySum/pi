-- One call checks a batch of files: sync each buffer with disk, ask every attached
-- language server about that text, and return what they said.
--
-- Neovim's own diagnostic cache is not used: it applies replies to cancelled pulls (which
-- servers may send empty) and then accepts "unchanged" for the text it just cleared.
local request = ...
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local PULL = 'textDocument/diagnostic'
-- A push server has no "finished" signal: it is done once it has reported and gone quiet.
local QUIET_MS, MAX_QUIET_MS, ATTEMPTS = 1000, 5000, 10
-- A client may be created a moment after a buffer loads; much later on a filetype's first use.
local ATTACH_MS, FIRST_ATTACH_MS = 300, 2000
local now = function() return uv.hrtime() / 1e6 end

-- Passive observers, installed once per Neovim. `seq` orders publishes against a file's sync.
local S = _G.__pi_nvim_diagnostics_v1
if not S then
  S = { seq = 0, pulls = {}, pushes = {}, synced = {}, gaps = {}, filetypes = {} }
  _G.__pi_nvim_diagnostics_v1 = S
  api.nvim_create_autocmd('LspRequest', {
    group = api.nvim_create_augroup('PiNvimDiagnostics', {}),
    callback = function(ev)
      local pull = S.pulls[ev.data.client_id .. ':' .. ev.data.request_id]
      if not pull then return end
      -- Neovim cancels every pending pull on a buffer when it refreshes its own, and
      -- servers may answer a cancelled pull with an empty report. Such a reply never counts.
      if ev.data.request.type == 'cancel' then pull.cancelled = true end
      if ev.data.request.type == 'complete' then
        -- A cancellation acknowledgement completes the request without calling its handler.
        vim.schedule(function() if not pull.replied then pull.finish() end end)
      end
    end,
  })
  -- The stock handler resolves this function at call time, so wrapping it sees every client.
  local publish = lsp.diagnostic.on_publish_diagnostics
  lsp.diagnostic.on_publish_diagnostics = function(err, params, ctx, ...)
    local name = vim.uri_to_fname(params.uri)
    local buf = vim.fn.bufexists(name) == 1 and vim.fn.bufadd(name) or nil
    -- A versioned report for text Neovim has since replaced says nothing about the current text.
    if buf and (params.version == nil or params.version == lsp.util.buf_versions[buf]) then
      local key, time = ctx.client_id .. ':' .. buf, now()
      local previous = S.pushes[key]
      -- vtsls clears a reopened file at once and sends the real report about 0.5 s later.
      -- Remember each server's longest pause between reports for one sync, so the quiet
      -- period outlasts it.
      if previous and previous.at > (S.synced[buf] or 0) then
        S.gaps[ctx.client_id] = math.max(S.gaps[ctx.client_id] or 0, time - previous.time)
      end
      S.seq = S.seq + 1
      S.pushes[key] = { at = S.seq, time = time, items = params.diagnostics }
    end
    return publish(err, params, ctx, ...)
  end
end

local started = now()

-- A no-op change: the text goes out under a new document version, so no server can
-- answer from a cache keyed on the old one, and push servers have to report again.
local function touch(f)
  pcall(api.nvim_buf_set_lines, f.buf, 0, 1, false, api.nvim_buf_get_lines(f.buf, 0, 1, false))
  vim.bo[f.buf].modified = f.unsaved
end

local function open(path)
  local f = { path = path, pulls = {} }
  local stat = uv.fs_stat(path)
  if not stat or stat.type ~= 'file' then f.error = stat and 'not a regular file' or 'no such file'; return f end
  f.buf = vim.fn.bufadd(path)
  local loaded = api.nvim_buf_is_loaded(f.buf)
  S.seq = S.seq + 1
  f.synced, S.synced[f.buf] = S.seq, S.seq
  vim.fn.bufload(f.buf)
  f.unsaved = vim.bo[f.buf].modified
  if loaded and not f.unsaved then
    local listed = vim.bo[f.buf].buflisted
    api.nvim_buf_call(f.buf, function() vim.cmd('silent keepalt keepjumps edit') end)
    vim.bo[f.buf].buflisted = listed
  end
  touch(f)
  f.filetype = vim.bo[f.buf].filetype
  return f
end

-- Servers with several diagnostic providers tell them apart by identifier.
local function identifiers(client, buf)
  local found = {}
  local static = client.server_capabilities.diagnosticProvider
  if type(static) == 'table' then found[static.identifier or false] = true end
  local dynamic = client.dynamic_capabilities
  local ok, registered = pcall(function() return dynamic:get(PULL, { bufnr = buf }) end)
  for _, r in ipairs(ok and registered and (registered.method and { registered } or registered) or {}) do
    found[type(r.registerOptions) == 'table' and r.registerOptions.identifier or false] = true
  end
  if not next(found) then found[false] = true end
  return vim.tbl_keys(found)
end

local function pull(f, client, identifier)
  local p = { attempts = 0 }
  local function send()
    p.attempts = p.attempts + 1
    -- Each attempt has its own state: a late event for an old request must not touch a newer one.
    local attempt, key = {}, nil
    function attempt.finish(err, result)
      if attempt.replied or p.closed then return end
      attempt.replied = true
      if key then S.pulls[key] = nil end
      -- ServerCancelled is the server asking to be asked again.
      if attempt.cancelled or not (err or result) or (err and err.code == -32802) then
        if p.attempts < ATTEMPTS then send() else p.error = 'cancelled repeatedly' end
      elseif err then p.error = tostring(err.message or err)
      elseif type(result) == 'table' and result.kind == 'full' then p.items = result.items or {}
      else p.error = 'unexpected reply' end
    end
    local params = { textDocument = { uri = vim.uri_from_bufnr(f.buf) }, identifier = identifier or nil }
    local ok, sent, id = pcall(client.request, client, PULL, params, attempt.finish, f.buf)
    if not ok or not sent then p.error = 'request not sent'; return end
    key = client.id .. ':' .. id
    S.pulls[key] = attempt
  end
  send()
  return p
end

-- The state of one client for one file, and the diagnostics it has given for the synced text.
local function ask(f, client)
  if not client.initialized then return 'starting' end
  if client:supports_method(PULL, f.buf) then
    f.pulls[client.id] = f.pulls[client.id] or vim.tbl_map(function(id) return pull(f, client, id) end, identifiers(client, f.buf))
    local items = {}
    for _, p in ipairs(f.pulls[client.id]) do
      if p.error then return 'failed: ' .. p.error end
      if not p.items then return 'pending' end
      vim.list_extend(items, p.items)
    end
    return 'answered', items
  end
  local e = S.pushes[client.id .. ':' .. f.buf]
  if not e or e.at <= f.synced then return 'silent' end
  local quiet = math.min(math.max(QUIET_MS, 2 * (S.gaps[client.id] or 0)), MAX_QUIET_MS)
  if next(client.progress.pending) or now() - e.time < quiet then return 'busy', e.items end
  return 'reported', e.items
end

local severity = { 'error', 'warning', 'info', 'hint' }
local function observe(f)
  local found = {}
  f.clients, f.done = {}, true
  for _, client in ipairs(lsp.get_clients({ bufnr = f.buf, _uninitialized = true })) do
    local status, items = ask(f, client)
    table.insert(f.clients, { name = client.name, status = status })
    f.done = f.done and (status == 'answered' or status == 'reported')
    for _, d in ipairs(items or {}) do
      local start = type(d.range) == 'table' and d.range.start or {}
      local line = api.nvim_buf_get_lines(f.buf, start.line or 0, (start.line or 0) + 1, false)[1] or ''
      local ok, column = pcall(vim.str_byteindex, line, client.offset_encoding, start.character or 0, false)
      table.insert(found, { line = (start.line or 0) + 1, column = (ok and column or start.character or 0) + 1,
        level = d.severity or 1, severity = severity[d.severity or 1] or 'error', source = d.source,
        code = d.code ~= nil and tostring(d.code) or nil, message = tostring(d.message or ''):sub(1, 2000) })
    end
  end
  if #f.clients == 0 then f.done = now() - started >= (S.filetypes[f.filetype] and ATTACH_MS or FIRST_ATTACH_MS) end
  f.found = found
  return f.done
end

local function collect(f)
  table.sort(f.found, function(a, b)
    if a.level ~= b.level then return a.level < b.level end
    if a.line ~= b.line then return a.line < b.line end
    return a.column < b.column
  end)
  f.counts, f.diagnostics = { error = 0, warning = 0, info = 0, hint = 0 }, {}
  for i, d in ipairs(f.found) do
    f.counts[d.severity] = f.counts[d.severity] + 1
    d.level = nil
    if i <= 500 then table.insert(f.diagnostics, d) end
  end
end

local files = {}
local ok, err = pcall(function()
  for _, path in ipairs(request.files) do
    local opened, f = pcall(open, path)
    table.insert(files, opened and f or { path = path, error = tostring(f) })
  end
  vim.wait(request.timeoutMs, function()
    local done = true
    for _, f in ipairs(files) do
      if not f.error then done = observe(f) and done end
    end
    return done
  end, 20)
  for _, f in ipairs(files) do
    if not f.error then observe(f); collect(f) end
  end
end)
for _, f in ipairs(files) do
  for _, pulls in pairs(f.pulls or {}) do
    for _, p in ipairs(pulls) do p.closed = true end -- Late replies and retries are no longer wanted.
  end
  if f.filetype then S.filetypes[f.filetype] = true end
  f.buf, f.synced, f.pulls, f.found, f.filetype = nil, nil, nil, nil, nil
end
if not ok then error(err, 0) end
return { files = files, elapsedMs = math.floor(now() - started) }
