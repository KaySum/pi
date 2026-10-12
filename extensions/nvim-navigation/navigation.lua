-- One call answers one question about code through the file's language servers: where a
-- symbol is defined or used, what it is, or what a file or project contains.
local request = ...
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local now = function() return uv.hrtime() / 1e6 end
local METHODS = {
  definition = 'textDocument/definition', declaration = 'textDocument/declaration', type = 'textDocument/typeDefinition',
  implementation = 'textDocument/implementation', references = 'textDocument/references', hover = 'textDocument/hover',
  symbols = 'textDocument/documentSymbol', workspace_symbols = 'workspace/symbol',
}
-- A client may be created a moment after a buffer loads; much later on a filetype's first use.
local ATTACH_MS, FIRST_ATTACH_MS, REATTACH_MS = 300, 2000, 1000
-- A server showing progress is loading or indexing, and would answer from half a picture.
-- Progress shorter than this is only a server ticking over.
local SUSTAINED_MS = 150
-- A server that has only just started gets this long to begin showing that it is loading.
local YOUNG_MS = 500
-- For this long after starting, a server's empty answer is checked again once it has shown
-- no progress for CALM_MS.
local RECENT_MS, CALM_MS = 15000, 700
-- How often a request is sent again when the server says its state changed under it.
local ATTEMPTS = 3
local MAX_ITEMS = 300

local S = _G.__pi_nvim_navigation_v2 or { filetypes = {}, born = {}, disk = {} }
_G.__pi_nvim_navigation_v2 = S
local started = now()

-- What the questions have to work with, for /nvim-navigation.
if request.status then
  local clients = {}
  for _, client in ipairs(lsp.get_clients({ _uninitialized = true })) do
    local actions = {}
    for action, name in pairs(METHODS) do
      if client.initialized and client:supports_method(name) then table.insert(actions, action) end
    end
    table.sort(actions)
    table.insert(clients, { id = client.id, name = client.name, root = client.root_dir, initialized = client.initialized, actions = actions,
      loading = next(client.progress.pending) ~= nil, buffers = vim.tbl_count(client.attached_buffers),
      ageMs = S.born[client.id] and math.floor(now() - S.born[client.id]) or nil })
  end
  return { clients = clients }
end

-- With request.trace, a timeline of what was sent and received.
local trace = request.trace and {} or nil
local function note(text)
  if trace then table.insert(trace, ('%5d ms  %s'):format(now() - started, text)) end
end
local method = METHODS[request.action]
local path = request.file

-- Bring a loaded buffer in line with its file; true if it had to be reloaded.
-- Reloading can detach a buffer's clients for a moment; `before` holds who is expected back.
local before = {}
local function refresh(b)
  local name = api.nvim_buf_get_name(b)
  if name == '' or vim.bo[b].buftype ~= '' or vim.bo[b].modified then return false end
  local stat = uv.fs_stat(name)
  if not stat or stat.type ~= 'file' then return false end
  -- Once the text has been seen to match, the file is only read again when its stat changes.
  local key = ('%d:%d:%d'):format(stat.mtime.sec, stat.mtime.nsec, stat.size)
  if S.disk[b] == key then return false end
  S.disk[b] = key
  local disk = vim.fn.readfile(name)
  if #disk == 0 then disk = { '' } end -- An empty file is one empty line to a buffer.
  if vim.bo[b].bomb then disk[1] = disk[1]:gsub('^\239\187\191', '') end
  if vim.bo[b].fileformat == 'dos' then
    for i, line in ipairs(disk) do disk[i] = line:gsub('\r$', '') end
  end
  local encoding = vim.bo[b].fileencoding
  if (encoding == '' or encoding == 'utf-8') and vim.deep_equal(disk, api.nvim_buf_get_lines(b, 0, -1, false)) then return false end
  local listed = vim.bo[b].buflisted
  for _, client in ipairs(lsp.get_clients({ bufnr = b })) do before[client.id] = true end
  api.nvim_buf_call(b, function() vim.cmd('silent keepalt keepjumps edit') end)
  vim.bo[b].buflisted = listed
  note(('%s: reloaded from disk'):format(vim.fs.basename(name)))
  return true
end

-- Load the file asked about. Then every other loaded file too: where a symbol is defined
-- or used is a question about the whole project, and a server answers from the buffers
-- it has open, not from disk.
local stat = uv.fs_stat(path)
if not stat or stat.type ~= 'file' then error(stat and 'not a regular file' or 'no such file', 0) end
local buf = vim.fn.bufadd(path)
local fresh = not api.nvim_buf_is_loaded(buf)
vim.fn.bufload(buf)
local unsaved = vim.bo[buf].modified
note(('%s: %s'):format(vim.fs.basename(path), fresh and 'loaded' or unsaved and 'unsaved buffer used as it is' or 'already loaded'))
for _, b in ipairs(api.nvim_list_bufs()) do
  if api.nvim_buf_is_loaded(b) and refresh(b) and b == buf then fresh = true end
end
local filetype = vim.bo[buf].filetype

-- The position asked about: a symbol's text on the line is easier to give than a column.
local position, symbol
if request.line then
  local text = api.nvim_buf_get_lines(buf, request.line - 1, request.line, false)[1]
  if not text then error(('line %d is past the end of the file (%d lines)'):format(request.line, api.nvim_buf_line_count(buf)), 0) end
  local column = request.column and request.column - 1
  if request.symbol then
    -- "name" means the word name, not the end of "rename": the first occurrence standing
    -- on its own is used, and only failing that the first one inside something longer.
    local from, at, whole = (column or 0) + 1, nil, nil
    while not whole do
      local s, e = text:find(request.symbol, from, true)
      if not s then break end
      at = at or s
      if not text:sub(s - 1, s - 1):match('[%w_]') and not text:sub(e + 1, e + 1):match('[%w_]') then whole = s end
      from = s + 1
    end
    at = whole or at
    if not at then error(('"%s" is not on line %d, which reads: %s'):format(request.symbol, request.line, vim.trim(text):sub(1, 200)), 0) end
    column = at - 1
  end
  if column > #text then error(('column %d is past the end of line %d'):format(column + 1, request.line), 0) end
  symbol = request.symbol or text:sub(column + 1):match('^[%w_]+') or text:sub(column + 1, column + 1)
  position = function(encoding) return { line = request.line - 1, character = vim.str_utfindex(text, encoding, column, false) } end
  note(('asking about %s at %d:%d'):format(vim.inspect(symbol), request.line, column + 1))
end

-- Wait for the file's servers to be running and done loading.
local clients = function() return lsp.get_clients({ bufnr = buf, _uninitialized = true }) end
local left = function() return math.max(0, request.timeoutMs - (now() - started)) end
local working, said = {}, {}
local ready = vim.wait(left(), function()
  local list, busy, attached = clients(), false, {}
  if #list == 0 then
    -- A client may yet appear: the buffer was loaded just now (here, or by another
    -- extension an instant ago, which is why a filetype's first use always waits), or a
    -- server somewhere is still starting.
    local grace = S.filetypes[filetype] and (fresh and ATTACH_MS or 0) or FIRST_ATTACH_MS
    local starting = #lsp.get_clients({ _uninitialized = true }) > #lsp.get_clients()
    return now() - started >= grace and (not starting or now() - started >= FIRST_ATTACH_MS)
  end
  for _, client in ipairs(list) do
    attached[client.id] = true
    local pending = next(client.progress.pending) ~= nil
    working[client.id] = pending and (working[client.id] or now()) or nil
    if client.initialized then S.born[client.id] = S.born[client.id] or now() end
    local state = not client.initialized and 'starting' or now() - S.born[client.id] < YOUNG_MS and 'just started'
      or pending and now() - working[client.id] >= SUSTAINED_MS and 'loading' or 'ready'
    if said[client.id] ~= state then said[client.id] = state; note(('%s is %s'):format(client.name, state)) end
    busy = busy or state ~= 'ready'
  end
  for id in pairs(before) do
    busy = busy or (not attached[id] and lsp.get_client_by_id(id) ~= nil and now() - started < REATTACH_MS)
  end
  return not busy
end, 20)
if #clients() == 0 then note('no language server attached') elseif not ready then note('gave up waiting for the servers') end
S.filetypes[filetype] = true

-- Neovim opens a reloaded document under its old version number, and some servers cache
-- by version (vtsls would return the old outline). A no-op change sends the text under a
-- new one. It has to wait until here: clients that were detached by the reload would miss it.
for _, b in ipairs(api.nvim_list_bufs()) do
  local ok, version = pcall(function() return lsp.util.buf_versions[b] end)
  if api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == '' and #lsp.get_clients({ bufnr = b }) > 0
      and not (ok and version == api.nvim_buf_get_changedtick(b)) then
    local modified = vim.bo[b].modified
    if pcall(api.nvim_buf_set_lines, b, 0, 1, false, api.nvim_buf_get_lines(b, 0, 1, false)) then
      note(('%s: sent under a new document version'):format(vim.fs.basename(api.nvim_buf_get_name(b))))
    end
    vim.bo[b].modified = modified
  end
end

-- Ask every server that can answer; returns one entry per attached server.
local function ask()
  local asked, servers = {}, {}
  for _, client in ipairs(clients()) do
    local entry = { name = client.name, encoding = client.offset_encoding, attempts = 0 }
    if not client.initialized then entry.status = 'starting'
    elseif not client:supports_method(method, buf) then entry.status = 'unsupported'
    else
      local params = request.action == 'workspace_symbols' and { query = request.query or '' }
        or { textDocument = { uri = vim.uri_from_bufnr(buf) }, position = position and position(client.offset_encoding),
          context = request.action == 'references' and { includeDeclaration = true } or nil }
      local function send()
        entry.attempts = entry.attempts + 1
        local ok, sent = pcall(client.request, client, method, params, function(err, result)
          -- ContentModified / ServerCancelled: the server's state moved while it was answering.
          if err and (err.code == -32801 or err.code == -32802) and entry.attempts < ATTEMPTS then
            note(('%s says its state changed (%s); asking again'):format(client.name, tostring(err.message or err.code)))
            return send()
          end
          entry.status = err and 'failed: ' .. tostring(err.message or err.code) or 'answered'
          if not err and result ~= vim.NIL and (type(result) ~= 'table' or next(result) ~= nil) then entry.result = result end
          note(('%s %s%s'):format(client.name, entry.status, err and '' or entry.result == nil and ' with nothing'
            or type(entry.result) == 'table' and #entry.result > 1 and (' with %d results'):format(#entry.result) or ' with a result'))
        end, buf)
        if not ok or not sent then entry.status = 'failed: request not sent' end
      end
      note(('%s asked for %s'):format(client.name, method))
      send()
      table.insert(asked, entry)
    end
    table.insert(servers, entry)
  end
  vim.wait(left(), function()
    for _, entry in ipairs(asked) do
      if not entry.status then return false end
    end
    return true
  end, 10)
  return servers
end

-- A server that started recently may answer "nothing" before it has loaded the project,
-- and only start showing progress afterwards (rust-analyzer). So an empty answer from one
-- is not believed until it has stayed calm for a while; then it is asked again.
local function recent()
  for _, client in ipairs(clients()) do
    if not S.born[client.id] or now() - S.born[client.id] < RECENT_MS then return true end
  end
end
-- True if somebody was asked and nobody had anything.
local function empty(servers)
  local asked = false
  for _, entry in ipairs(servers) do
    if entry.result ~= nil then return false end
    asked = asked or (entry.status ~= 'unsupported' and entry.status ~= 'starting')
  end
  return asked
end
local servers = ask()
for _ = 1, ATTEMPTS - 1 do
  if not empty(servers) or not recent() or left() == 0 then break end
  note('nothing from a server that started recently; waiting for it to stay calm, then asking again')
  local calm
  ready = vim.wait(left(), function()
    for _, client in ipairs(clients()) do
      if not client.initialized or next(client.progress.pending) then calm = nil; return false end
    end
    calm = calm or now()
    return now() - calm >= CALM_MS
  end, 20)
  servers = ask()
end

-- Turn replies into plain rows.
local out = { path = path, symbol = symbol, query = request.query, unsaved = unsaved, loading = not ready, servers = {}, items = {},
  trace = trace, elapsedMs = math.floor(now() - started) }
local lines, seen = {}, {}
local function source(file)
  if not lines[file] then
    -- bufadd finds an existing buffer by exact name; bufnr would read the path as a pattern.
    local loaded = vim.fn.bufloaded(file) == 1 and vim.fn.bufadd(file) or nil
    lines[file] = loaded and api.nvim_buf_get_lines(loaded, 0, -1, false) or (vim.fn.filereadable(file) == 1 and vim.fn.readfile(file) or {})
  end
  return lines[file]
end
local function place(uri, range, encoding)
  local file = uri:match('^file:') and vim.uri_to_fname(uri) or uri
  local text = range and source(file)[range.start.line + 1] or ''
  local ok, column = pcall(vim.str_byteindex, text, encoding, range and range.start.character or 0, false)
  return { path = file, line = range and range.start.line + 1 or nil, column = range and (ok and column or range.start.character) + 1 or nil,
    text = vim.trim(text):sub(1, 200) }
end
local function add(item, key)
  if seen[key] then return end
  seen[key] = true
  out.total = (out.total or 0) + 1
  if #out.items < MAX_ITEMS then table.insert(out.items, item) end
end
local kinds = lsp.protocol.SymbolKind
local function outline(list, depth, encoding, parent)
  local start = function(s) local r = s.selectionRange or s.range or (s.location and s.location.range); return r and r.start.line or 0 end
  if request.action == 'symbols' then table.sort(list, function(a, b) return start(a) < start(b) end) end
  for _, s in ipairs(list) do
    local range = s.selectionRange or s.range or (s.location and s.location.range)
    local name = tostring(s.name)
    if not request.query or name:lower():find(request.query:lower(), 1, true) then
      local item = s.location and place(s.location.uri, range, encoding) or { line = range and range.start.line + 1 }
      -- A filtered outline has lost its nesting, so each match names its parent instead.
      item.name, item.kind, item.text = name, (kinds[s.kind] or 'Symbol'):lower(), nil
      item.depth, item.container = request.query and 0 or depth, s.containerName or (request.query and parent or nil)
      if request.action == 'symbols' then item.path = nil end
      add(item, table.concat({ item.path or '', item.line or 0, name, item.kind }, '\0'))
    end
    if s.children then outline(s.children, depth + 1, encoding, name) end
  end
end

for _, entry in ipairs(servers) do
  table.insert(out.servers, { name = entry.name, status = entry.status or 'no answer' })
  local result = entry.result
  if result == nil then -- nothing to add
  elseif request.action == 'hover' then
    local contents, parts = result.contents, {}
    if type(contents) == 'string' or (type(contents) == 'table' and contents.value) then contents = { contents } end
    for _, part in ipairs(type(contents) == 'table' and contents or {}) do
      local value = type(part) == 'string' and part or part.value
      if value and vim.trim(value) ~= '' then table.insert(parts, vim.trim(value)) end
    end
    if #parts > 0 then add({ server = entry.name, text = table.concat(parts, '\n\n'):sub(1, 8000) }, table.concat(parts, '\n')) end
  elseif request.action == 'symbols' or request.action == 'workspace_symbols' then
    outline(result, 0, entry.encoding)
  else
    -- One Location, a list of them, or a list of LocationLinks.
    for _, location in ipairs((result.uri or result.targetUri) and { result } or result) do
      local item = place(location.targetUri or location.uri, location.targetSelectionRange or location.range, entry.encoding)
      add(item, table.concat({ item.path, item.line or 0, item.column or 0 }, '\0'))
    end
  end
end
return out
