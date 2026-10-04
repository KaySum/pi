-- Only read-only LSP requests; no UI handlers, edits, commands, or save events.
if _G.__pi_semantic_v1 then return true end
local api, B = vim.api, assert(_G.__pi_nvim_buffers_v1)
local M = { requests = {} }
_G.__pi_semantic_v1 = M
local methods = {
  definition = 'textDocument/definition', declaration = 'textDocument/declaration',
  type_definition = 'textDocument/typeDefinition', implementation = 'textDocument/implementation',
  references = 'textDocument/references', hover = 'textDocument/hover',
  document_symbols = 'textDocument/documentSymbol', workspace_symbols = 'workspace/symbol',
}
local function integer(n) return type(n) == 'number' and n >= 0 and n <= 2147483647 and n % 1 == 0 end
local function range(value)
  assert(type(value) == 'table' and type(value.start) == 'table' and type(value['end']) == 'table', 'Invalid LSP range')
  local a, z = value.start, value['end']
  assert(integer(a.line) and integer(a.character) and integer(z.line) and integer(z.character), 'Invalid LSP position')
  assert(z.line > a.line or (z.line == a.line and z.character >= a.character), 'Reversed LSP range')
  return { start = { line = a.line, character = a.character }, ['end'] = { line = z.line, character = z.character } }
end
local function clip(r, value, maximum)
  assert(type(value) == 'string', 'Invalid LSP text')
  if #value <= maximum then return value end
  r.truncated = true
  local stop = maximum + 1
  while stop > 1 and value:byte(stop) >= 128 and value:byte(stop) < 192 do stop = stop - 1 end
  return value:sub(1, stop - 1)
end
local function uri(value)
  assert(type(value) == 'string' and #value <= 8192 and not value:find('\0', 1, true), 'Invalid LSP URI')
  return value
end
local function add(r, p, item)
  local cost = #vim.json.encode(item)
  if r.count >= r.params.limit or r.bytes + cost > 1024 * 1024 then
    r.truncated = true; p.omitted = p.omitted + 1
  else
    r.count = r.count + 1; r.bytes = r.bytes + cost
    table.insert(p.items, item)
  end
end
local function location(value)
  assert(type(value) == 'table', 'Invalid LSP location')
  if value.targetUri then
    return { uri = uri(value.targetUri), lspRange = range(value.targetSelectionRange or value.targetRange), lspFullRange = range(value.targetRange) }
  end
  return { uri = uri(value.uri), lspRange = value.range and range(value.range) or nil }
end
local function normalize(r, p, result)
  if result == nil or result == vim.NIL then return end
  assert(type(result) == 'table', 'Invalid LSP response')
  local op = r.params.operation
  if op == 'hover' then
    local contents = result.contents
    if contents == nil or contents == vim.NIL then return end
    local item = { contents = {}, uri = vim.uri_from_bufnr(r.files[1].entry.buf), lspRange = result.range and range(result.range) or nil }
    if type(contents) == 'string' or contents.value then contents = { contents } end
    assert(type(contents) == 'table', 'Invalid hover contents')
    local size = 0
    for i, content in ipairs(contents) do
      if i > 64 or size >= 65536 then r.truncated = true; break end
      local value = type(content) == 'string' and content or content.value
      local text = clip(r, value, 65536 - size)
      size = size + #text
      table.insert(item.contents, { text = text, kind = type(content) == 'table' and content.kind == 'plaintext' and 'plaintext' or 'markdown',
        language = type(content) == 'table' and content.language and clip(r, content.language, 128) or nil })
    end
    if #item.contents > 0 then add(r, p, item) end
  elseif op == 'document_symbols' or op == 'workspace_symbols' then
    local visited = 0
    local function symbols(list, parent, depth)
      assert(type(list) == 'table', 'Invalid symbol list')
      if depth > 32 then r.truncated = true; return end
      for _, symbol in ipairs(list) do
        visited = visited + 1
        if visited > 10000 then r.truncated = true; return end
        local name = clip(r, symbol.name, 2048)
        local item
        if symbol.location then item = location(symbol.location)
        else item = { uri = vim.uri_from_bufnr(r.files[1].entry.buf), lspRange = range(symbol.selectionRange or symbol.range), lspFullRange = range(symbol.range) } end
        item.name = name
        item.kind = vim.lsp.protocol.SymbolKind[symbol.kind] or 'Unknown'
        item.container = symbol.containerName and clip(r, symbol.containerName, 2048) or parent
        item.detail = symbol.detail and clip(r, symbol.detail, 8192) or nil
        if op == 'workspace_symbols' or not r.params.query or name:lower():find(r.params.query:lower(), 1, true) then add(r, p, item) end
        if symbol.children then symbols(symbol.children, clip(r, (parent and parent .. '.' or '') .. name, 2048), depth + 1) end
      end
    end
    symbols(result, nil, 0)
  else
    if result.uri or result.targetUri then result = { result } end
    for i, value in ipairs(result) do
      if i > 10000 then r.truncated = true; break end
      local item = location(value)
      assert(item.lspRange, 'Navigation location has no range')
      add(r, p, item)
    end
  end
end
function M.finish(token) B.finish(token) end
function M.begin(token, input, params, deadline)
  assert(methods[params.operation], 'Unsupported semantic operation')
  local r = B.begin(token, { input }, deadline)
  M.requests[token] = r
  r.params = params; r.providers = {}; r.version = 0; r.count = 0; r.bytes = 0; r.token = token
  r.on_finish = function()
    M.requests[token] = nil
    for _, p in pairs(r.providers) do
      if p.id and p.status == 'pending' then pcall(p.client.cancel_request, p.client, p.id) end
    end
  end
  local f = r.files[1]
  if not B.state(f) and params.line then
    local line = api.nvim_buf_get_lines(f.entry.buf, params.line - 1, params.line, false)[1]
    local byte = line and line:byte(params.column)
    if not line or params.column > #line + 1 or (byte and byte >= 128 and byte < 192) then
      f.status = 'invalid_position'; f.error = 'Position is outside the buffer or splits a UTF-8 character'
    else r.line = line end
  end
  if not B.state(f) then
    local encoding = vim.bo[f.entry.buf].fileencoding
    if encoding ~= '' and encoding ~= 'utf-8' then f.status = 'unsupported_encoding'; f.error = 'Neovim did not decode this file as UTF-8' end
  end
  return true
end
local function request(r, p)
  local f, input = r.files[1], r.params
  local params = { textDocument = { uri = vim.uri_from_bufnr(f.entry.buf) } }
  if input.operation == 'workspace_symbols' then params = { query = input.query }
  elseif input.line then
    params.position = { line = input.line - 1, character = vim.str_utfindex(r.line, p.client.offset_encoding, input.column - 1) }
    if input.operation == 'references' then params.context = { includeDeclaration = input.includeDeclaration ~= false } end
  end
  p.status = 'pending'; r.version = r.version + 1
  local ok, sent, id = pcall(p.client.request, p.client, methods[input.operation], params, function(err, result)
    if M.requests[r.token] ~= r then return end
    r.version = r.version + 1
    if B.state(f) then p.status = 'error'; p.error = 'Source buffer changed during request'
    elseif err then p.status = 'error'; p.error = clip(r, tostring(err.message or err), 4096)
    else
      local parsed, message = pcall(normalize, r, p, result)
      if parsed then p.status = #p.items == 0 and p.omitted == 0 and 'empty' or 'completed'
      else p.status = 'error'; p.error = clip(r, tostring(message), 4096) end
    end
  end, f.entry.buf)
  if not ok or not sent then p.status = 'error'; p.error = clip(r, tostring(id or sent), 4096)
  else p.id = id end
end
function M.snapshot(token, include_items)
  local r = assert(M.requests[token], 'Semantic request expired')
  local f = r.files[1]
  local status = B.state(f)
  local extra = 0
  if not status then
    local clients = vim.lsp.get_clients({ bufnr = f.entry.buf })
    table.sort(clients, function(a, b) return a.id < b.id end)
    for i, client in ipairs(clients) do
      if i > 16 or (not r.providers[client.id] and vim.tbl_count(r.providers) >= 16) then extra = extra + 1
      else
        local p = r.providers[client.id]
        if not p then
          p = { client = client, status = 'initializing', items = {}, omitted = 0 }; r.providers[client.id] = p; r.version = r.version + 1
        end
        if client.initialized and (p.status == 'initializing' or p.status == 'unsupported') then
          if client:supports_method(methods[r.params.operation], f.entry.buf) then request(r, p)
          elseif p.status ~= 'unsupported' then p.status = 'unsupported'; r.version = r.version + 1 end
        end
      end
    end
  end
  local providers = {}
  for _, p in pairs(r.providers) do
    table.insert(providers, { id = p.client.id, name = clip(r, p.client.name, 512), root = type(p.client.config.root_dir) == 'string' and clip(r, p.client.config.root_dir, 4096) or nil,
      encoding = p.client.offset_encoding, status = p.status, error = p.error, items = include_items and p.items or {}, count = #p.items, omitted = p.omitted })
  end
  table.sort(providers, function(a, b) return a.id < b.id end)
  return { status = status, error = f.error, refreshed = f.refreshed, changedtick = f.tick, providers = providers,
    version = r.version, truncated = r.truncated == true, extraClients = extra }
end
function M.check(token) return { status = B.state(assert(M.requests[token]).files[1]) } end
function M.inspect(paths) return B.inspect(paths) end
return true
