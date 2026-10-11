-- One call checks a batch of files: bring each buffer in line with disk, collect what
-- every language server and linter says about that text, and return it.
--
-- Neovim's own diagnostic cache is not used for language servers: it applies replies to
-- cancelled pulls (which servers may send empty) and then accepts "unchanged" for the
-- text it just cleared.
local request = ...
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local PULL = 'textDocument/diagnostic'
local now = function() return uv.hrtime() / 1e6 end
local clamp = function(value, low, high) return math.min(math.max(value, low), high) end

-- How many times a pull is sent again after being cancelled.
local ATTEMPTS = 10
-- A client may be created a moment after a buffer loads; much later on a filetype's first use.
local ATTACH_MS, FIRST_ATTACH_MS = 300, 2000
-- A push server has no "finished" signal. After new text it is given a window to report,
-- sized from how long it has taken before, and must then stay quiet briefly.
local QUIET_MS, MIN_WINDOW_MS, MAX_WINDOW_MS = 300, 1000, 10000
-- The window for a server with no record yet, and for one that never reports.
local UNKNOWN_WINDOW_MS, MUTE_WINDOW_MS = 2500, 500
-- A push server that has only just started may still be loading its project, without
-- saying so. Until it reports for the first time it is not called silent this early.
local COLD_MS = 5000
-- A server showing progress (loading a project, running cargo check) is not finished, and
-- an answer it gives meanwhile may be empty. It must be idle this long before one counts.
local SETTLE_MS = 300
-- Progress shorter than this is a server ticking over (pyright flashes one after every
-- answer), not work whose result has to be waited for.
local SUSTAINED_MS = 150
-- Buffers this tool loaded stay loaded, so servers keep their state, up to this many.
local MAX_BUFFERS = 64

-- Everything remembered between calls, for the life of this Neovim:
--   buffers[bufnr]  what is known about a checked buffer: its epoch (the last time its text
--                   changed as far as the servers are concerned), each server's last report,
--                   its linters, and the disk state and changedtick it was last synced at
--   servers[id]     what has been learned about a language server's behavior
--   pulls[key]      diagnostic requests in flight, by "client:request"
--   seq             orders reports against epochs; clock orders buffers by last use
local S = _G.__pi_nvim_diagnostics_v3
if not S then
  S = { seq = 0, clock = 0, buffers = {}, servers = {}, pulls = {}, filetypes = {} }
  _G.__pi_nvim_diagnostics_v3 = S
  function S.note() end
  function S.server(id)
    S.servers[id] = S.servers[id] or { mute = 0 }
    return S.servers[id]
  end
  api.nvim_create_autocmd('LspRequest', {
    group = api.nvim_create_augroup('PiNvimDiagnostics', {}),
    callback = function(ev)
      local pull = S.pulls[ev.data.client_id .. ':' .. ev.data.request_id]
      if not pull then return end
      -- Neovim cancels every pending pull on a buffer when it refreshes its own, and
      -- servers may answer a cancelled pull with an empty report. Such a reply never counts.
      if ev.data.request.type == 'cancel' then pull.cancelled = true; S.note(pull.label .. ' cancelled by Neovim') end
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
    local b = vim.fn.bufexists(name) == 1 and S.buffers[vim.fn.bufadd(name)]
    if b then
      S.seq = S.seq + 1
      S.server(ctx.client_id).reports = true
      b.pushes[ctx.client_id] = { at = S.seq, time = now(), items = params.diagnostics }
      S.note(('%s published %d for %s'):format(lsp.get_client_by_id(ctx.client_id).name, #params.diagnostics, vim.fs.basename(name)))
    end
    return publish(err, params, ctx, ...)
  end
end

local started = now()

-- How long a push server gets to report on new text before its silence is believed.
local function window(server)
  if server.latency then return clamp(1.5 * server.latency, MIN_WINDOW_MS, MAX_WINDOW_MS) end
  -- A server that has stayed silent through two changes (tailwindcss outside a Tailwind
  -- project, in-process helpers) is not waited on at length again.
  return server.mute >= 2 and MUTE_WINDOW_MS or UNKNOWN_WINDOW_MS
end

if request.status then
  local clients = {}
  for _, client in ipairs(lsp.get_clients({ _uninitialized = true })) do
    local server = S.server(client.id)
    table.insert(clients, { id = client.id, name = client.name, root = client.root_dir, initialized = client.initialized,
      pull = client.initialized and client:supports_method(PULL) or false, windowMs = math.floor(window(server)),
      reports = server.reports == true, buffers = vim.tbl_count(client.attached_buffers) })
  end
  return { clients = clients, pendingPulls = vim.tbl_count(S.pulls), trackedBuffers = vim.tbl_count(S.buffers) }
end

-- With request.trace, a timeline of what was sent and received, for /nvim-diagnostics.
local trace = request.trace and {} or nil
function S.note(text)
  if trace then table.insert(trace, ('%5d ms  %s'):format(now() - started, text)) end
end

-- Forget servers that have exited and buffers that were unloaded behind this tool's back.
local function forget()
  for id in pairs(S.servers) do
    if not lsp.get_client_by_id(id) then S.servers[id] = nil end
  end
  for buf in pairs(S.buffers) do
    if not api.nvim_buf_is_valid(buf) or not api.nvim_buf_is_loaded(buf) then S.buffers[buf] = nil end
  end
end

-- Unload the least recently checked buffers this tool loaded, once there are too many.
-- A buffer anyone else has a claim on (shown, listed, or with unsaved changes) is kept.
local function prune()
  local idle = {}
  for buf, b in pairs(S.buffers) do
    if b.owned and not vim.bo[buf].modified and not vim.bo[buf].buflisted and #vim.fn.win_findbuf(buf) == 0 then
      table.insert(idle, buf)
    end
  end
  table.sort(idle, function(x, y) return S.buffers[x].used < S.buffers[y].used end)
  for i = 1, #idle - MAX_BUFFERS do
    if pcall(api.nvim_buf_delete, idle[i], { unload = true }) then S.buffers[idle[i]] = nil end
  end
end

-- Learn from the epoch that is ending: how long each push server took to finish reporting
-- (including reports that arrived after the check returned), and which never reported.
local function learn(b)
  for id, ready in pairs(b.epoch.ready) do
    local server, report = S.server(id), b.pushes[id]
    if report and report.at > b.epoch.at then
      -- Not a measure of the server's pace: its first report after starting up (loading the
      -- project), or one that followed a change to another file (which makes servers like
      -- vtsls report again for every open file).
      local startup = (server.born or 0) >= b.epoch.time
      local sample = report.time - math.max(b.epoch.time, ready)
      if startup or report.time > (b.epoch.superseded or math.huge) then server.latency = server.latency or 0
      elseif sample < MAX_WINDOW_MS then server.latency = math.max(sample, 0.8 * (server.latency or 0)) end
    elseif not server.latency then server.mute = server.mute + 1 end
  end
end

-- Load the file's buffer and, if its text is not what the servers already have, start a
-- new epoch for it. Returns the check's working state for this file.
local function open(path)
  local f = { path = path, name = vim.fs.basename(path), pulls = {}, seen = {}, out = { path = path } }
  local stat = uv.fs_stat(path)
  if not stat or stat.type ~= 'file' then f.out.error = stat and 'not a regular file' or 'no such file'; return f end
  local buf = vim.fn.bufadd(path)
  local loaded = api.nvim_buf_is_loaded(buf)
  local b = S.buffers[buf] or { pushes = {}, linters = {}, owned = not loaded }
  S.buffers[buf], S.clock = b, S.clock + 1
  b.used = S.clock
  vim.fn.bufload(buf)
  f.buf, f.b, f.out.unsaved = buf, b, vim.bo[buf].modified
  local disk = ('%d:%d:%d'):format(stat.mtime.sec, stat.mtime.nsec, stat.size)
  local reload = loaded and not f.out.unsaved and b.disk ~= disk
  -- Text the servers already have is left alone: reopening it would only make them clear
  -- and recompute, and their last word on it still stands.
  if loaded and not reload and b.tick == api.nvim_buf_get_changedtick(buf) then
    S.note(('%s: unchanged since the last check'):format(f.name))
  else
    f.loading, f.saved = reload or not loaded, not f.out.unsaved
    if b.epoch then learn(b) end
    for _, other in pairs(S.buffers) do
      if other.epoch then other.epoch.superseded = other.epoch.superseded or now() end
    end
    S.seq = S.seq + 1
    b.epoch = { at = S.seq, time = now(), ready = {} }
    if reload then
      local listed = vim.bo[buf].buflisted
      api.nvim_buf_call(buf, function() vim.cmd('silent keepalt keepjumps edit') end)
      vim.bo[buf].buflisted = listed
    end
    -- A no-op change sends the text under a new document version, so no server can
    -- answer from a cache keyed on the old one.
    pcall(api.nvim_buf_set_lines, buf, 0, 1, false, api.nvim_buf_get_lines(buf, 0, 1, false))
    vim.bo[buf].modified = f.out.unsaved
    S.note(('%s: %s, document version %d'):format(f.name,
      f.out.unsaved and 'unsaved buffer' or reload and 'reloaded from disk' or 'loaded', api.nvim_buf_get_changedtick(buf)))
    -- nvim-lint only lints the buffer a person is looking at, so run it here.
    local ok, lint = pcall(require, 'lint')
    if ok and type(lint.try_lint) == 'function' then
      api.nvim_buf_call(buf, function() pcall(lint.try_lint) end)
      b.linters = lint.get_running(buf)
    end
    b.disk, b.tick = disk, api.nvim_buf_get_changedtick(buf)
  end
  f.filetype = vim.bo[buf].filetype
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

-- Ask one provider for the buffer's diagnostics, again if the request gets cancelled.
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
      S.note(('%s: %s'):format(attempt.label, attempt.cancelled and 'reply discarded (cancelled)'
        or err and 'error ' .. tostring(err.message or err.code) or not result and 'no reply (cancellation acknowledged)'
        or ('%s, %d diagnostics'):format(tostring(result.kind), #(result.items or {}))))
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
    attempt.label = ('%s pull #%d for %s'):format(client.name, id, f.name)
    S.pulls[key] = attempt
    S.note(('%s sent%s'):format(attempt.label, p.attempts > 1 and ' (attempt ' .. p.attempts .. ')' or ''))
  end
  send()
  return p
end

-- The first time a server is seen ready for this epoch.
local function greet(f, client, server)
  f.b.epoch.ready[client.id] = now()
  server.born = server.born or now()
  -- A server that has just started, or is known to show progress, gets a moment to start
  -- showing it before anything it says is believed.
  if server.progressive or not server.busy then server.busy = now() end
  -- The buffer matches the file, which is what "saved" means, and some servers only do
  -- their real checking then: rust-analyzer runs cargo check, eslint can lint on save.
  -- It is said here, not at the reload, because clients may re-attach a moment after it.
  if f.saved and client:supports_method('textDocument/didSave', f.buf) then
    local sync = client.server_capabilities.textDocumentSync
    local text = type(sync) == 'table' and type(sync.save) == 'table' and sync.save.includeText
      and table.concat(api.nvim_buf_get_lines(f.buf, 0, -1, false), '\n') .. '\n' or nil
    client:notify('textDocument/didSave', { textDocument = { uri = vim.uri_from_bufnr(f.buf) }, text = text })
    S.note(('%s told %s was saved'):format(client.name, f.name))
  end
end

-- The state of one client for one file, and the diagnostics it has given for its text.
local function ask(f, client)
  if not client.initialized then return 'starting' end
  local server, epoch = S.server(client.id), f.b.epoch
  if not epoch.ready[client.id] then greet(f, client, server) end
  local working = next(client.progress.pending) ~= nil
  server.working = working and (server.working or now()) or nil
  local sustained = working and now() - server.working >= SUSTAINED_MS
  if sustained then server.busy, server.progressive = now(), true end
  local report = f.b.pushes[client.id]
  local fresh = report and report.at > epoch.at

  if client:supports_method(PULL, f.buf) then
    if sustained or now() - server.busy < SETTLE_MS then
      -- Whatever it answered while busy is not to be trusted; ask again once it is idle.
      for _, p in ipairs(f.pulls[client.id] or {}) do p.closed = true end
      f.pulls[client.id] = nil
      return 'busy'
    end
    if working then return 'busy' end
    f.pulls[client.id] = f.pulls[client.id] or vim.tbl_map(function(id) return pull(f, client, id) end, identifiers(client, f.buf))
    local items = {}
    for _, p in ipairs(f.pulls[client.id]) do
      if p.error then return 'failed: ' .. p.error end
      if not p.items then return 'pending' end
      vim.list_extend(items, p.items)
    end
    -- Some servers answer for their own analysis and publish the rest (rust-analyzer
    -- publishes cargo check's errors), so what they published for this text counts too.
    return 'answered', fresh and vim.list_extend(items, report.items) or items
  end

  local since = math.max(epoch.time, epoch.ready[client.id])
  local cold = not server.reports and now() - server.born < COLD_MS
  if working or cold or now() - since < window(server) or (fresh and now() - report.time < QUIET_MS) then
    return 'busy', fresh and report.items or nil
  end
  -- A server that reported nothing new may simply have nothing new to say (marksman only
  -- publishes changes), so its last report is shown rather than dropped.
  return fresh and 'reported' or report and 'no new report' or 'silent', report and report.items
end

local severity = { 'error', 'warning', 'info', 'hint' }
local settled = { answered = true, reported = true, ['no new report'] = true, silent = true, linted = true }

-- Take stock of every source for one file; true once they have all settled.
local function observe(f)
  local out, found = f.out, {}
  local function add(line, column, level, d)
    table.insert(found, { line = line + 1, column = column + 1, level = level, severity = severity[level] or 'error',
      source = d.source, code = d.code ~= nil and tostring(d.code) or nil, message = tostring(d.message or ''):sub(1, 2000) })
  end
  local function state(name, id, status)
    table.insert(out.clients, { name = name, status = status })
    out.done = out.done and settled[status] == true
    if f.seen[id] ~= status then
      f.seen[id] = status
      S.note(('%s: %s is %s'):format(f.name, name, status))
    end
  end
  out.clients, out.done = {}, true
  for _, client in ipairs(lsp.get_clients({ bufnr = f.buf, _uninitialized = true })) do
    local status, items = ask(f, client)
    state(client.name, client.id, status)
    for _, d in ipairs(items or {}) do
      local start = type(d.range) == 'table' and d.range.start or {}
      local text = api.nvim_buf_get_lines(f.buf, start.line or 0, (start.line or 0) + 1, false)[1] or ''
      local ok, column = pcall(vim.str_byteindex, text, client.offset_encoding, start.character or 0, false)
      add(start.line or 0, ok and column or start.character or 0, d.severity or 1, d)
    end
  end
  -- A client may be created a moment after the buffer is (re)loaded.
  local attached = #out.clients > 0 or not f.loading or now() - started >= (S.filetypes[f.filetype] and ATTACH_MS or FIRST_ATTACH_MS)
  local running = package.loaded.lint and package.loaded.lint.get_running(f.buf) or {}
  for _, name in ipairs(f.b.linters) do
    state(name, name, vim.tbl_contains(running, name) and 'linting' or 'linted')
  end
  -- Linters and other non-LSP sources write to Neovim's store, where nothing overwrites them.
  for _, d in ipairs(vim.diagnostic.get(f.buf)) do
    if not vim.diagnostic.get_namespace(d.namespace).name:match('^n?vim%.lsp%.') then add(d.lnum, d.col, d.severity, d) end
  end
  out.done = out.done and attached
  f.found = found
  return out.done
end

-- Order, de-duplicate and count what was found for one file.
local function collect(f)
  table.sort(f.found, function(a, b)
    if a.level ~= b.level then return a.level < b.level end
    if a.line ~= b.line then return a.line < b.line end
    return a.column < b.column
  end)
  f.out.counts, f.out.diagnostics = { error = 0, warning = 0, info = 0, hint = 0 }, {}
  local seen = {}
  for _, d in ipairs(f.found) do
    -- A server that both answers and publishes may say the same thing twice.
    local key = table.concat({ d.line, d.column, d.severity, d.code or '', d.message }, '\0')
    if not seen[key] then
      seen[key] = true
      f.out.counts[d.severity] = f.out.counts[d.severity] + 1
      d.level = nil
      if #f.out.diagnostics < 500 then table.insert(f.out.diagnostics, d) end
    end
  end
end

forget()
local files = {}
local ok, err = pcall(function()
  for _, path in ipairs(request.files) do
    local opened, f = pcall(open, path)
    table.insert(files, opened and f or { out = { path = path, error = tostring(f) } })
  end
  vim.wait(request.timeoutMs, function()
    local done = true
    for _, f in ipairs(files) do
      if not f.out.error then done = observe(f) and done end
    end
    return done
  end, 20)
  for _, f in ipairs(files) do
    if not f.out.error then observe(f); collect(f) end
  end
end)
for _, f in ipairs(files) do
  for _, pulls in pairs(f.pulls or {}) do
    for _, p in ipairs(pulls) do p.closed = true end -- Late replies and retries are no longer wanted.
  end
  if f.filetype then S.filetypes[f.filetype] = true end
end
pcall(prune)
local timeline = trace
trace = nil -- Events between calls are not part of any timeline.
if not ok then error(err, 0) end
return { files = vim.tbl_map(function(f) return f.out end, files), elapsedMs = math.floor(now() - started), trace = timeline }
