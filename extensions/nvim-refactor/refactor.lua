-- One call has a language server change code: rename a symbol everywhere it is used, or
-- list the code actions for a place and apply one. What changed is written to disk.
local request = ...
local api, lsp, uv = vim.api, vim.lsp, vim.uv or vim.loop
local now = function() return uv.hrtime() / 1e6 end
-- A server's error is not final if it says its state changed under the request or it
-- began loading meanwhile: the request is made again, this often and this far apart.
local ATTEMPTS, RETRY_MS = 5, 300
-- An edit that a command has the server send may arrive just after the command's reply. One
-- that arrives later still is refused, for as long as the server may yet send it.
local COMMAND_MS, LATE_MS = 300, 10000
-- Buffers that were put back are given this long for their servers to return.
local REATTACH_MS = 1000
local METHOD = request.action == 'rename' and 'textDocument/rename' or 'textDocument/codeAction'
local started = now()
local left = function() return math.max(0, request.timeoutMs - (now() - started)) end
local refuse = function(...) error(string.format(...), 0) end

local path = request.file
local stat = uv.fs_stat(path)
if not stat or stat.type ~= 'file' then refuse(stat and 'not a regular file' or 'no such file') end
local buf = vim.fn.bufadd(path)
local loaded = not api.nvim_buf_is_loaded(buf) and now() or nil
vim.fn.bufload(buf)

-- The files on disk are what gets changed, and a server answers from the buffers it has
-- open: every loaded buffer picks up what was written since. One with unsaved changes is
-- left as it is, and nothing may change it.
local unsaved = {}
for _, b in ipairs(api.nvim_list_bufs()) do
  if api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == '' then
    if vim.bo[b].modified then unsaved[b] = true
    elseif uv.fs_stat(api.nvim_buf_get_name(b)) then
      local tick = api.nvim_buf_get_changedtick(b)
      vim.bo[b].autoread = true
      vim.cmd('silent checktime ' .. b)
      if b == buf and tick ~= api.nvim_buf_get_changedtick(b) then loaded = now() end
    end
  end
end
if unsaved[buf] then refuse("its buffer in Pi's Neovim has unsaved changes") end

-- The place asked about, in bytes: a symbol's text on the line is easier to give than a
-- column. Without a line it is the whole file; with only a line, the whole of it.
local last = api.nvim_buf_line_count(buf)
local from, to, symbol = { 1, 0 }, { last, #api.nvim_buf_get_lines(buf, last - 1, last, false)[1] }, nil
if request.line then
  local text = api.nvim_buf_get_lines(buf, request.line - 1, request.line, false)[1]
  if not text then refuse('line %d is past the end of the file (%d lines)', request.line, last) end
  local column = request.column and request.column - 1
  if request.symbol then
    -- "name" means the word name, not the end of "rename": the first occurrence standing
    -- on its own is used, and only failing that the first one inside something longer.
    local start, at, whole = (column or 0) + 1, nil, nil
    while not whole do
      local s, e = text:find(request.symbol, start, true)
      if not s then break end
      at = at or s
      if not text:sub(s - 1, s - 1):match('[%w_]') and not text:sub(e + 1, e + 1):match('[%w_]') then whole = s end
      start = s + 1
    end
    at = whole or at
    if not at then refuse('"%s" is not on line %d, which reads: %s', request.symbol, request.line, vim.trim(text):sub(1, 200)) end
    column = at - 1
  end
  if column and column > #text then refuse('column %d is past the end of line %d', column + 1, request.line) end
  symbol = request.symbol or column and text:sub(column + 1):match('^[%w_]+')
  from = { request.line, column or 0 }
  to = request.endLine and { request.endLine, #(api.nvim_buf_get_lines(buf, request.endLine - 1, request.endLine, false)[1] or '') }
    or { request.line, column and column + #(request.symbol or '') or #text }
  if request.endLine and request.endLine > last then refuse('endLine %d is past the end of the file (%d lines)', request.endLine, last) end
end
local uri = vim.uri_from_bufnr(buf)
local function position(place, encoding)
  local text = api.nvim_buf_get_lines(buf, place[1] - 1, place[1], false)[1]
  return { line = place[1] - 1, character = vim.str_utfindex(text, encoding, place[2], false) }
end

local clients = function() return lsp.get_clients({ bufnr = buf, method = METHOD }) end
vim.wait(left(), function() return #clients() > 0 or servers.attached(buf, loaded) end, 20)
servers.seen(buf)
if #clients() == 0 then return { servers = 0 } end

-- The edit that renames the symbol, and the server it came from: the first that can
-- rename what is there.
local function rename()
  local problem, again
  for _, client in ipairs(clients()) do
    local params = { textDocument = { uri = uri }, position = position(from, client.offset_encoding) }
    local can = true
    if client:supports_method('textDocument/prepareRename', buf) then
      can, problem, again = servers.ask(client, 'textDocument/prepareRename', params, buf, left())
    end
    if can then
      params.newName = request.newName
      local edit
      edit, problem, again = servers.ask(client, METHOD, params, buf, left())
      if edit then return { edit = edit, client = client } end
    end
    if again then return nil, problem, true end
    problem = problem or client.name .. ': there is nothing to rename there'
  end
  return nil, problem
end

-- Every code action the servers offer for the place, with the server each came from.
local function actions()
  -- As other editors do, each server is told of every diagnostic there, whoever found it.
  local diagnostics = {}
  for _, d in ipairs(vim.diagnostic.get(buf)) do
    local found = d.user_data and d.user_data.lsp
    if found and d.lnum < to[1] and (d.end_lnum or d.lnum) >= from[1] - 1 then table.insert(diagnostics, found) end
  end
  local list, problems = {}, {}
  for _, client in ipairs(clients()) do
    local encoding = client.offset_encoding
    local found, problem, again = servers.ask(client, METHOD, { textDocument = { uri = uri },
      range = { start = position(from, encoding), ['end'] = position(to, encoding) },
      context = { diagnostics = diagnostics, only = request.kind and { request.kind }, triggerKind = 1 } }, buf, left())
    if again then return nil, problem, true end
    if problem then table.insert(problems, problem) end
    for _, action in ipairs(type(found) == 'table' and found or {}) do
      -- Kinds nest: "source" asks for "source.organizeImports" too. Not every server filters.
      local kind = action.kind or ''
      if not request.kind or kind == request.kind or vim.startswith(kind, request.kind .. '.') then
        table.insert(list, { action = action, client = client })
      end
    end
  end
  return list, problems
end

local function read(file)
  local handle = io.open(file, 'rb')
  if not handle then return '' end
  local bytes = handle:read('*a')
  handle:close()
  return bytes
end
local function modified()
  local list = {}
  for _, b in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == '' and vim.bo[b].modified and not unsaved[b] then table.insert(list, b) end
  end
  return list
end
-- A change that failed part-way must not leave half-changed buffers behind. Reloading one
-- detaches its servers for a moment: they are waited for, since the next request needs them.
local function undo()
  local attached = {}
  for _, b in ipairs(modified()) do
    attached[b] = lsp.get_clients({ bufnr = b })
    pcall(api.nvim_buf_call, b, function() vim.cmd('silent keepalt keepjumps edit!') end)
  end
  vim.wait(REATTACH_MS, function()
    for b, list in pairs(attached) do
      for _, client in ipairs(list) do
        if not client.attached_buffers[b] and not client:is_stopped() then return false end
      end
    end
    return true
  end, 20)
end

-- Why an edit must not be applied, if it must not, and whether asking for it again may help.
local function objection(edit, client)
  local roots = { uv.fs_realpath(request.cwd), client.root_dir and uv.fs_realpath(client.root_dir) }
  for _, folder in ipairs(client.workspace_folders or {}) do table.insert(roots, uv.fs_realpath(vim.uri_to_fname(folder.uri))) end
  local function check(target, version)
    local file = vim.uri_to_fname(target)
    local real = uv.fs_realpath(file) or uv.fs_realpath(vim.fs.dirname(file)) or file
    local inside = false
    for _, root in pairs(roots) do inside = inside or vim.startswith(real .. '/', root .. '/') end
    if not inside then return file .. ' is outside the project' end
    local b = vim.fn.bufadd(file)
    if unsaved[b] then return file .. " has unsaved changes in Pi's Neovim" end
    -- Neovim skips such a file and says so on screen, leaving the change half made. And it
    -- takes version 0 for no version at all.
    if type(version) == 'number' and client.attached_buffers[b] and lsp.util.buf_versions[b] ~= version then
      return ('%s answered about an older text of %s'):format(client.name, file), true
    end
  end
  for _, change in ipairs(edit.documentChanges or {}) do
    for _, target in ipairs({ change.uri or change.newUri or change.textDocument.uri, change.oldUri }) do
      local problem, again = check(target, change.textDocument and change.textDocument.version)
      if problem then return problem, again end
    end
  end
  for target in pairs(not edit.documentChanges and edit.changes or {}) do
    local problem = check(target)
    if problem then return problem end
  end
end

-- Apply an edit unless something speaks against it: what that is, and whether asking for
-- the edit again may help. `moved` collects the files it creates, renames or deletes, which
-- Neovim changes on disk itself. vtsls sends a "create" for every file it edits, to be
-- ignored if the file exists.
local function apply(edit, client, moved)
  local problem, again = objection(edit, client)
  if problem then return problem, again end
  for _, op in ipairs(edit.documentChanges or {}) do
    local file = op.kind and vim.uri_to_fname(op.uri or op.newUri)
    if file and (op.kind == 'rename' or (op.kind == 'create') ~= (uv.fs_stat(file) ~= nil)) then
      table.insert(moved, { kind = op.kind, path = file, from = op.oldUri and vim.uri_to_fname(op.oldUri) })
    end
  end
  lsp.util.apply_workspace_edit(edit, client.offset_encoding)
end

-- Run a command: in the editor if a plugin defines it there, otherwise in the server, which
-- sends back the edits to make. Those are held to the same rules as any other, not left to
-- Neovim. Returns what went wrong, if anything.
local function execute(command, client, moved)
  local here = client.commands[command.command] or lsp.commands[command.command]
  if here then return here(command, { bufnr = buf, client_id = client.id }) end
  local APPLY = 'workspace/applyEdit'
  local open, edits, problem, original = true, 0, nil, client.handlers[APPLY]
  local function handler(_, params)
    if not open then return { applied = false, failureReason = 'the command that asked for this edit has ended' } end
    edits = edits + 1
    local ok, objected = pcall(apply, params.edit, client, moved)
    problem = problem or objected
    return { applied = ok and not objected, failureReason = objected }
  end
  client.handlers[APPLY] = handler
  local reply, silence = client:request_sync('workspace/executeCommand', { command = command.command, arguments = command.arguments }, left(), buf)
  if reply and not reply.err then vim.wait(math.min(COMMAND_MS, left()), function() return edits > 0 end, 20) end
  open = false
  vim.defer_fn(function() if client.handlers[APPLY] == handler then client.handlers[APPLY] = original end end, LATE_MS)
  return problem or not reply and ('%s: %s'):format(client.name, silence) or reply.err and ('%s: %s'):format(client.name, reply.err.message or reply.err.code) or nil
end

-- What the buffer's file holds if it holds just what the buffer does, for the plain case.
local function same(b, file)
  if vim.bo[b].bomb or not vim.tbl_contains({ '', 'utf-8' }, vim.bo[b].fileencoding) then return false end
  local eol = vim.bo[b].fileformat == 'dos' and '\r\n' or '\n'
  local text, disk = table.concat(api.nvim_buf_get_lines(b, 0, -1, false), eol), read(file)
  return disk == text or disk == text .. eol
end

-- Apply an edit, and after it a command, then write every file that changed. Returns the
-- files with the lines that changed in each, or nil, what went wrong and whether to retry.
local function change(edit, command, client)
  if left() == 0 then return nil, 'timeout' end
  local moved, problem, again = {}, nil, nil
  local ok, err = pcall(function()
    if edit then problem, again = apply(edit, client, moved) end
    if command and not problem then problem = execute(command, client, moved) end
  end)
  -- Nothing is written unless all of it can be: asked to write a read-only file anyway, an
  -- editor with 'confirm' set stops at a dialog.
  local changed = modified()
  for _, b in ipairs(changed) do
    local file = api.nvim_buf_get_name(b)
    if uv.fs_stat(file) and (vim.bo[b].readonly or vim.fn.filewritable(file) ~= 1) then problem = problem or file .. ' is read-only' end
  end
  if not ok then problem, again = err, false end
  if not problem and left() == 0 then problem = 'timeout' end
  if problem then
    undo()
    return nil, vim.trim(tostring(problem):gsub('\nstack traceback:.*', '')):gsub('%s+', ' '):sub(1, 500), again
  end

  local files = {}
  for _, b in ipairs(changed) do
    local file = api.nvim_buf_get_name(b)
    local before = read(file)
    -- An edit may put back what was there: Neovim calls the buffer changed all the same.
    if uv.fs_stat(file) and same(b, file) then
      vim.bo[b].modified = false
    else
      api.nvim_buf_call(b, function()
        -- A file without a final newline stays without one. No autocommands: format-on-save
        -- would reformat files that were only meant to be renamed in.
        local fix = vim.bo.fixendofline
        vim.bo.fixendofline = false
        vim.cmd('silent noautocmd write')
        vim.bo.fixendofline = fix
      end)
      -- Where the file changed, as line ranges of what it holds now.
      local ranges = {}
      for _, hunk in ipairs(vim.diff(before, read(file), { result_type = 'indices' })) do
        local first = math.max(hunk[3], 1)
        table.insert(ranges, { first, first + math.max(hunk[4], 1) - 1 })
      end
      if #ranges > 0 then table.insert(files, { path = file, changed = ranges }) end
    end
  end
  table.sort(files, function(a, b) return a.path < b.path end)
  return { files = files, moved = moved }
end

local function describe(found)
  return vim.tbl_map(function(entry)
    local action = entry.action
    return { title = action.title, kind = action.kind, server = entry.client.name, disabled = action.disabled and (action.disabled.reason or '') or nil }
  end, found)
end

local function run()
  if request.action == 'rename' then
    local found, problem, again = rename()
    if not found then return nil, problem, again end
    local out
    out, problem, again = change(found.edit, nil, found.client)
    if not out then return nil, problem, again end
    out.server, out.symbol = found.client.name, symbol
    return out
  end

  local found, problems, again = actions()
  if not found then return nil, problems, again end
  if #found == 0 and #problems > 0 then return nil, table.concat(problems, '; ') end
  local out = { actions = describe(found), problems = problems }
  if request.action == 'actions' then return out end

  -- The one to apply is named by its title, or by a part of it, or by its kind when that
  -- leaves only one. One that is disabled is only meant when no other matches.
  local function pick(test)
    local enabled, disabled = {}, {}
    for _, entry in ipairs(found) do
      if test(entry.action.title) then table.insert(entry.action.disabled and disabled or enabled, entry) end
    end
    return #enabled > 0 and enabled or disabled
  end
  local wanted = request.title and request.title:lower()
  local matches = pick(function(title) return title == request.title end)
  if #matches == 0 then matches = pick(function(title) return not wanted or title:lower():find(wanted, 1, true) ~= nil end) end
  if #matches ~= 1 then
    out.matches = describe(matches)
    return out
  end
  local action, client = matches[1].action, matches[1].client
  if action.disabled then return nil, ('"%s" is disabled: %s'):format(action.title, action.disabled.reason or 'no reason given') end
  -- A server may leave out what an action does until it is chosen. A bare command has no more to give.
  if type(action.command) ~= 'string' and not (action.edit and action.command) and client:supports_method('codeAction/resolve', buf) then
    local resolved, problem
    resolved, problem, again = servers.ask(client, 'codeAction/resolve', action, buf, left())
    if resolved then action = resolved elseif not (action.edit or action.command) then return nil, problem, again end
  end
  local done, problem
  done, problem, again = change(action.edit, type(action.command) == 'table' and action.command or action.command and action, client)
  if not done then return nil, problem, again end
  done.title, done.server = action.title, client.name
  return done
end

local out, problem, again
for attempt = 1, ATTEMPTS do
  out, problem, again = run()
  if out or not again or attempt == ATTEMPTS or left() <= RETRY_MS then break end
  vim.wait(RETRY_MS)
end
if not out then refuse('%s', problem) end
return out
