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
local ATTACH_MS, FIRST_ATTACH_MS = 300, 2000
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

local S = _G.__pi_nvim_navigation_v1 or { filetypes = {}, born = {} }
_G.__pi_nvim_navigation_v1 = S
local started = now()
local method = METHODS[request.action]
local path = request.file

-- Load the buffer, and reload it if the file no longer says what the buffer does.
local stat = uv.fs_stat(path)
if not stat or stat.type ~= 'file' then error(stat and 'not a regular file' or 'no such file', 0) end
local buf = vim.fn.bufadd(path)
local fresh = not api.nvim_buf_is_loaded(buf)
vim.fn.bufload(buf)
local unsaved = vim.bo[buf].modified
if not fresh and not unsaved then
  local disk = vim.fn.readfile(path)
  if vim.bo[buf].bomb and disk[1] then disk[1] = disk[1]:gsub('^\239\187\191', '') end
  if vim.bo[buf].fileformat == 'dos' then
    for i, line in ipairs(disk) do disk[i] = line:gsub('\r$', '') end
  end
  local encoding = vim.bo[buf].fileencoding
  if (encoding ~= '' and encoding ~= 'utf-8') or not vim.deep_equal(disk, api.nvim_buf_get_lines(buf, 0, -1, false)) then
    local listed = vim.bo[buf].buflisted
    api.nvim_buf_call(buf, function() vim.cmd('silent keepalt keepjumps edit') end)
    vim.bo[buf].buflisted = listed
    fresh = true
    -- A no-op change sends the text under a new document version: some servers (vtsls's
    -- outline) cache by version and would otherwise answer for the old text.
    pcall(api.nvim_buf_set_lines, buf, 0, 1, false, api.nvim_buf_get_lines(buf, 0, 1, false))
    vim.bo[buf].modified = false
  end
end
local filetype = vim.bo[buf].filetype

-- The position asked about: a symbol's text on the line is easier to give than a column.
local position, symbol
if request.line then
  local text = api.nvim_buf_get_lines(buf, request.line - 1, request.line, false)[1]
  if not text then error(('line %d is past the end of the file (%d lines)'):format(request.line, api.nvim_buf_line_count(buf)), 0) end
  local column = request.column and request.column - 1
  if request.symbol then
    local at = text:find(request.symbol, (column or 0) + 1, true)
    if not at then error(('"%s" is not on line %d, which reads: %s'):format(request.symbol, request.line, vim.trim(text):sub(1, 200)), 0) end
    column = at - 1
  end
  if column > #text then error(('column %d is past the end of line %d'):format(column + 1, request.line), 0) end
  symbol = request.symbol or text:sub(column + 1):match('^[%w_]+') or text:sub(column + 1, column + 1)
  position = function(encoding) return { line = request.line - 1, character = vim.str_utfindex(text, encoding, column, false) } end
end

-- Wait for the file's servers to be running and done loading.
local clients = function() return lsp.get_clients({ bufnr = buf, _uninitialized = true }) end
local left = function() return math.max(0, request.timeoutMs - (now() - started)) end
local working = {}
local ready = vim.wait(left(), function()
  local list, busy = clients(), false
  if #list == 0 then return not fresh or now() - started >= (S.filetypes[filetype] and ATTACH_MS or FIRST_ATTACH_MS) end
  for _, client in ipairs(list) do
    local pending = next(client.progress.pending) ~= nil
    working[client.id] = pending and (working[client.id] or now()) or nil
    if client.initialized then S.born[client.id] = S.born[client.id] or now() end
    busy = busy or not client.initialized or now() - S.born[client.id] < YOUNG_MS
      or (pending and now() - working[client.id] >= SUSTAINED_MS)
  end
  return not busy
end, 20)
S.filetypes[filetype] = true

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
          if err and (err.code == -32801 or err.code == -32802) and entry.attempts < ATTEMPTS then return send() end
          entry.status = err and 'failed: ' .. tostring(err.message or err.code) or 'answered'
          if not err and result ~= vim.NIL and (type(result) ~= 'table' or next(result) ~= nil) then entry.result = result end
        end, buf)
        if not ok or not sent then entry.status = 'failed: request not sent' end
      end
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
local function empty(servers)
  for _, entry in ipairs(servers) do
    if entry.result ~= nil then return false end
  end
  return true
end
local servers = ask()
for _ = 1, ATTEMPTS - 1 do
  if not empty(servers) or not recent() or left() == 0 then break end
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
local out = { path = path, symbol = symbol, query = request.query, unsaved = unsaved, loading = not ready, servers = {}, items = {} }
local lines, seen = {}, {}
local function source(file)
  if not lines[file] then
    local loaded = vim.fn.bufloaded(file) == 1 and vim.fn.bufnr(file) or nil
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
local function outline(list, depth, encoding)
  local start = function(s) local r = s.selectionRange or s.range or (s.location and s.location.range); return r and r.start.line or 0 end
  if request.action == 'symbols' then table.sort(list, function(a, b) return start(a) < start(b) end) end
  for _, s in ipairs(list) do
    local range = s.selectionRange or s.range or (s.location and s.location.range)
    local name = tostring(s.name)
    if not request.query or name:lower():find(request.query:lower(), 1, true) then
      local item = s.location and place(s.location.uri, range, encoding) or { line = range and range.start.line + 1 }
      item.name, item.kind, item.depth, item.container, item.text = name, (kinds[s.kind] or 'Symbol'):lower(), depth, s.containerName, nil
      if request.action == 'symbols' then item.path = nil end
      add(item, table.concat({ item.path or '', item.line or 0, name, item.kind }, '\0'))
    end
    if s.children then outline(s.children, depth + 1, encoding) end
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
