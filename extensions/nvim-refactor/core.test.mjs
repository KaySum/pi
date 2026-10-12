import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from '../nvim-service/service.mjs';
import { openNvim } from '../nvim-service/nvim.mjs';
import { parse, refactor, validate } from './core.mjs';

// Language servers inside Neovim, attaching a moment after a file loads and named by its
// extension (`a.server`, `b.error`). `server` renames a word in every file of the same
// extension, open or not, except the word `fixed`; it reports lines containing `bad` and
// offers the code actions below. `stale` answers the first rename for a version of the
// file it no longer has, `error` fails it, `outside` wants to change a file elsewhere,
// and `plain` can do neither. `store` renames in the texts it was sent. `odd` offers actions that are hard to get right: its
// commands reply first and send their edit 50 ms later, `late` 500 ms later.
const SERVERS = `vim.o.confirm = true
local function utf16(line, byte) return vim.str_utfindex(line, 'utf-16', byte, false) end
local function span(l1, c1, l2, c2) return { start = { line = l1, character = c1 }, ['end'] = { line = l2, character = c2 } } end
local function lines_of(file)
  return vim.fn.bufloaded(file) == 1 and vim.api.nvim_buf_get_lines(vim.fn.bufadd(file), 0, -1, false) or vim.fn.readfile(file)
end
local function server(kind)
  return function(dispatchers)
    local closing, asked = false, 0
    local function word_at(params)
      local line = lines_of(vim.uri_to_fname(params.textDocument.uri))[params.position.line + 1] or ''
      for s, word in line:gmatch('()([%w_]+)') do
        if utf16(line, s - 1) <= params.position.character and params.position.character <= utf16(line, s - 1 + #word) then return word end
      end
    end
    local documents = {}
    local function replace(lines, word, new)
      local edits = {}
      for i, line in ipairs(lines) do
        for s in line:gmatch('()%f[%w_]' .. word .. '%f[^%w_]') do
          table.insert(edits, { range = span(i - 1, utf16(line, s - 1), i - 1, utf16(line, s - 1 + #word)), newText = new })
        end
      end
      return #edits > 0 and edits or nil
    end
    local function rename(params)
      local asked_file, word, changes = vim.uri_to_fname(params.textDocument.uri), word_at(params), {}
      local dir, ext = vim.fs.dirname(asked_file), vim.fn.fnamemodify(asked_file, ':e')
      for name in vim.fs.dir(dir) do
        if name:sub(-#ext - 1) == '.' .. ext then changes[vim.uri_from_fname(dir .. '/' .. name)] = replace(lines_of(dir .. '/' .. name), word, params.newName) end
      end
      -- As a real server does, this one goes by the text it was sent, not by the buffers.
      if kind == 'store' then
        changes = {}
        for uri, text in pairs(documents) do changes[uri] = replace(vim.split(text, '\\n'), word, params.newName) end
      end
      return changes
    end
    local function actions(params)
      local uri, row = params.textDocument.uri, params.range.start.line
      local lines = lines_of(vim.uri_to_fname(uri))
      local line, only, list = lines[row + 1] or '', params.context.only and params.context.only[1], {}
      local whole = function(text) return { changes = { [uri] = { { range = span(0, 0, #lines, 0), newText = text } } } } end
      if only and vim.startswith(only, 'source') then
        return { { title = 'Organize imports', kind = 'source.organizeImports', edit = whole(table.concat(vim.fn.sort(vim.deepcopy(lines)), '\\n') .. '\\n') } }
      end
      if line:find('todo') then table.insert(list, { title = 'Remove the todo', kind = 'quickfix', edit = { changes = { [uri] = { { range = span(row, 0, row + 1, 0), newText = '' } } } } }) end
      for _, d in ipairs(params.context.diagnostics) do
        table.insert(list, { title = 'Fix: ' .. d.message, kind = 'quickfix', edit = { changes = { [uri] = { { range = d.range, newText = 'good' } } } } })
      end
      local selected = params.range['end'].line == row and line:sub(params.range.start.character + 1, params.range['end'].character) or ''
      vim.list_extend(list, {
        { title = 'Upper-case ' .. (selected == line and 'the line' or selected), kind = 'refactor.rewrite',
          data = { uri = uri, row = row, from = params.range.start.character, to = params.range['end'].character, last = params.range['end'].line } },
        { title = 'Reverse the lines', command = 'reverse', arguments = { uri } },
        { title = 'Move the line to notes', kind = 'refactor.move', edit = { documentChanges = {
          { kind = 'create', uri = uri .. '.notes' },
          { textDocument = { uri = uri .. '.notes', version = vim.NIL }, edits = { { range = span(0, 0, 0, 0), newText = line } } },
          { textDocument = { uri = uri, version = vim.lsp.util.buf_versions[vim.uri_to_bufnr(uri)] }, edits = { { range = span(row, 0, row + 1, 0), newText = '' } } },
        } } },
        { title = 'Inline the line', kind = 'refactor.inline', disabled = { reason = 'nothing to inline' } },
      })
      return vim.tbl_filter(function(action) return not only or vim.startswith(action.kind or '', only) end, list)
    end
    local function odd(params)
      local uri = params.textDocument.uri
      local first = function(target, text) return { changes = { [target] = { { range = span(0, 0, 0, 1), newText = text } } } } end
      local other = vim.uri_from_fname(vim.uri_to_fname(uri) .. '.other')
      return {
        { title = 'Same', edit = first(uri, 'A') }, { title = 'Same', edit = first(uri, 'B') },
        { title = 'Nothing', edit = first(uri, lines_of(vim.uri_to_fname(uri))[1]:sub(1, 1)) },
        { title = 'Elsewhere', command = 'edit', arguments = { 50, first(vim.uri_from_fname('/etc/hosts'), 'Y') } },
        { title = 'Other', command = 'edit', arguments = { 50, first(other, 'Y') } },
        { title = 'Late', command = 'edit', arguments = { 500, first(other, 'Y') } },
        { title = 'Both', edit = first(uri, 'Y'), command = { title = 'Both', command = 'edit', arguments = { 50, first(other, 'Y') } } },
      }
    end
    local function publish(uri)
      local diagnostics = {}
      for i, line in ipairs(lines_of(vim.uri_to_fname(uri))) do
        local s = line:find('bad', 1, true)
        if s then table.insert(diagnostics, { range = span(i - 1, s - 1, i - 1, s + 2), message = 'bad word', severity = 1 }) end
      end
      dispatchers.notification('textDocument/publishDiagnostics', { uri = uri, diagnostics = diagnostics })
    end
    return {
      request = function(method, params, callback)
        if method == 'initialize' then
          callback(nil, { capabilities = { textDocumentSync = { openClose = true, change = 1 }, renameProvider = kind ~= 'plain' and { prepareProvider = kind == 'server' } or nil,
            codeActionProvider = kind == 'server' and { resolveProvider = true } or kind == 'odd' or nil, executeCommandProvider = { commands = { 'reverse', 'edit' } } } })
        elseif method == 'textDocument/prepareRename' then
          local word = word_at(params)
          callback(nil, word and word ~= 'fixed' and { defaultBehavior = true } or vim.NIL)
        elseif method == 'textDocument/rename' and kind == 'error' then callback({ code = -32603, message = 'cannot rename this' })
        elseif method == 'textDocument/rename' and kind == 'outside' then
          callback(nil, { changes = { [vim.uri_from_fname('/etc/hosts')] = { { range = span(0, 0, 0, 0), newText = params.newName } } } })
        elseif method == 'textDocument/rename' and kind == 'stale' then
          asked = asked + 1
          local documents = {}
          for uri, edits in pairs(rename(params)) do
            local version = vim.lsp.util.buf_versions[vim.uri_to_bufnr(uri)]
            table.insert(documents, { textDocument = { uri = uri, version = asked == 1 and 0 or version }, edits = edits })
          end
          callback(nil, { documentChanges = documents })
        elseif method == 'textDocument/rename' then callback(nil, { changes = rename(params) })
        elseif method == 'textDocument/codeAction' then callback(nil, kind == 'odd' and odd(params) or actions(params))
        elseif method == 'workspace/executeCommand' and params.command == 'edit' then
          vim.defer_fn(function() dispatchers.server_request('workspace/applyEdit', { edit = params.arguments[2] }) end, params.arguments[1])
          callback(nil, vim.NIL)
        elseif method == 'codeAction/resolve' then
          local d = params.data
          local line = d and lines_of(vim.uri_to_fname(d.uri))[d.row + 1]
          if d and d.last == d.row then
            params.edit = { changes = { [d.uri] = { { range = span(d.row, d.from, d.row, d.to), newText = line:sub(d.from + 1, d.to):upper() } } } }
          end
          callback(nil, params)
        elseif method == 'workspace/executeCommand' then
          local uri = params.arguments[1]
          local lines = lines_of(vim.uri_to_fname(uri))
          local reversed = {}
          for i = #lines, 1, -1 do table.insert(reversed, lines[i]) end
          dispatchers.server_request('workspace/applyEdit', { edit = { changes = { [uri] = { { range = span(0, 0, #lines, 0), newText = table.concat(reversed, '\\n') .. '\\n' } } } } })
          callback(nil, vim.NIL)
        else callback(nil, vim.NIL) end
        return true, 1
      end,
      notify = function(method, params)
        if method == 'textDocument/didOpen' then documents[params.textDocument.uri] = params.textDocument.text end
        if method == 'textDocument/didChange' then documents[params.textDocument.uri] = params.contentChanges[1].text end
        if kind == 'server' and (method == 'textDocument/didOpen' or method == 'textDocument/didChange') then
          vim.schedule(function() publish(params.textDocument.uri) end)
        end
        return true
      end,
      is_closing = function() return closing end,
      terminate = function() closing = true end,
    }
  end
end
vim.api.nvim_create_autocmd('BufReadPost', { callback = function(ev)
  vim.defer_fn(function()
    local kind = vim.fn.fnamemodify(ev.file, ':e')
    if ({ server = 1, stale = 1, error = 1, outside = 1, plain = 1, odd = 1, store = 1 })[kind] then vim.lsp.start({ name = kind, cmd = server(kind) }, { bufnr = ev.buf }) end
  end, 150)
end })`;

async function fixture(t) {
  const directory = await realpath(await mkdtemp('/tmp/pi-refactor-test-'));
  await writeFile(join(directory, 'init.lua'), SERVERS);
  const service = launch({ cwd: directory, init: join(directory, 'init.lua'), graceMs: 100, killMs: 300 });
  const nvim = await openNvim(await service.ready);
  t.after(async () => { nvim.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, nvim,
    write: (name, text) => writeFile(join(directory, name), text),
    read: name => readFile(join(directory, name), 'utf8'),
    run: async (action, file, options) => (await refactor(nvim, { action, file, ...options }, directory)).split('\n'),
    buffer: name => nvim.lua('local b = vim.fn.bufadd(...); return { vim.api.nvim_buf_get_lines(b, 0, -1, false), vim.bo[b].modified }', [join(directory, name)]),
  };
}

test('rejects requests that cannot be made, before touching the editor', () => {
  for (const params of [undefined, {}, { action: 'extract', file: 'a' }, { action: 'rename', file: '' }, { action: 'rename', file: 'a', line: 1, symbol: 'x' },
    { action: 'rename', file: 'a', line: 1, newName: 'y' }, { action: 'rename', file: 'a', symbol: 'x', newName: 'y' }, { action: 'rename', file: 'a', line: 0, symbol: 'x', newName: 'y' },
    { action: 'rename', file: 'a', line: 1, symbol: 'x', newName: 'y\nz' }, { action: 'actions', file: 'a', symbol: 'x' }, { action: 'actions', file: 'a', line: 3, endLine: 2 },
    { action: 'actions', file: 'a', line: 3, endLine: 4, symbol: 'x' }, { action: 'apply', file: 'a', line: 1 }, { action: 'actions', file: 'a', timeoutMs: 50 }]) {
    assert.throws(() => validate(params));
  }
  assert.deepEqual(validate({ action: 'rename', file: 'a', line: 3, symbol: 'x', newName: 'y', title: 'ignored' }),
    { action: 'rename', file: 'a', line: 3, symbol: 'x', column: undefined, newName: 'y', timeoutMs: 10000 });
  assert.deepEqual(validate({ action: 'apply', file: 'a', kind: 'source.organizeImports' }),
    { action: 'apply', file: 'a', line: undefined, symbol: undefined, column: undefined, endLine: undefined, title: undefined, kind: 'source.organizeImports', timeoutMs: 10000 });
  assert.deepEqual(parse('rename src/a.ts 3 greet welcome'), { action: 'rename', file: 'src/a.ts', line: 3, symbol: 'greet', newName: 'welcome' });
  assert.deepEqual(parse('apply src/a.ts 3 Add  import'), { action: 'apply', file: 'src/a.ts', line: 3, title: 'Add import' });
  assert.deepEqual(parse('actions src/a.ts'), { action: 'actions', file: 'src/a.ts', line: undefined, title: undefined });
});

test('renames a symbol in every file that uses it, open or not, and writes them', async t => {
  const f = await fixture(t);
  await f.write('lib.server', 'def greet\ngreeting stays\n');
  await f.write('use.server', '-- é😀 greet and greet again\ncall greet inner\n');
  await f.write('other.txt', 'greet\n');
  await f.write('end.server', 'greet');
  // The file with the other uses has not been opened; the symbol is found past wider characters.
  assert.deepEqual(await f.run('rename', 'use.server', { line: 1, symbol: 'greet', newName: 'welcome' }), [
    'Renamed greet to welcome in 3 files — server', 'end.server: lines 1 changed', 'lib.server: lines 1 changed', 'use.server: lines 1-2 changed']);
  // A file without a final newline is not given one.
  assert.equal(await f.read('end.server'), 'welcome');
  assert.equal(await f.read('lib.server'), 'def welcome\ngreeting stays\n');
  assert.equal(await f.read('use.server'), '-- é😀 welcome and welcome again\ncall welcome inner\n');
  assert.equal(await f.read('other.txt'), 'greet\n');
  assert.deepEqual(await f.buffer('lib.server'), [['def welcome', 'greeting stays'], false]);

  // The files are renamed in as they are on disk now, not as the editor last saw them.
  await f.write('lib.server', 'def welcome\nwelcome twice\n');
  assert.deepEqual(await f.run('rename', 'use.server', { line: 2, column: 6, newName: 'hi' }), [
    'Renamed welcome to hi in 3 files — server', 'end.server: lines 1 changed', 'lib.server: lines 1-2 changed', 'use.server: lines 1-2 changed']);
  assert.equal(await f.read('lib.server'), 'def hi\nhi twice\n');
  assert.equal(await f.read('use.server'), '-- é😀 hi and hi again\ncall hi inner\n');
});

test('a server is sent every change before it is asked about the project', async t => {
  const f = await fixture(t);
  await f.write('a.store', 'x\n');
  await f.write('b.store', 'x\n');
  const rename = (symbol, newName) => f.run('rename', 'a.store', { line: 1, symbol, newName });
  assert.deepEqual(await rename('x', 'y'), ['Renamed x to y in 1 file — store', 'a.store: lines 1 changed']);
  await f.nvim.lua('local b = vim.fn.bufadd(...); vim.fn.bufload(b); vim.wait(1000, function() return #vim.lsp.get_clients({ bufnr = b }) > 0 end)', [join(f.directory, 'b.store')]);
  // Neovim holds back the change to b for 150 ms: renaming back at once must still find it there.
  assert.deepEqual(await rename('y', 'x'), ['Renamed y to x in 1 file — store', 'a.store: lines 1 changed']);
  assert.deepEqual(await rename('x', 'y'), ['Renamed x to y in 2 files — store', 'a.store: lines 1 changed', 'b.store: lines 1 changed']);
  assert.deepEqual(await rename('y', 'x'), ['Renamed y to x in 2 files — store', 'a.store: lines 1 changed', 'b.store: lines 1 changed']);
  assert.equal(await f.read('b.store'), 'x\n');
});

test('a rename that cannot be made whole changes nothing', async t => {
  const f = await fixture(t);
  const refused = (file, options, pattern) => assert.rejects(f.run('rename', file, { newName: 'y', ...options }), pattern);
  await f.write('a.server', 'fixed x\n');
  await f.write('b.server', 'x\n');
  await refused('a.server', { line: 1, symbol: 'fixed' }, /^Error: server: there is nothing to rename there$/);
  await refused('a.server', { line: 1, symbol: 'nope' }, /"nope" is not on line 1, which reads: fixed x/);
  await refused('a.server', { line: 9, symbol: 'x' }, /line 9 is past the end of the file \(1 lines\)/);
  await refused('gone.server', { line: 1, symbol: 'x' }, /^Error: no such file$/);

  // One file of several cannot be written: none is.
  await chmod(join(f.directory, 'b.server'), 0o444);
  await refused('a.server', { line: 1, symbol: 'x' }, /b\.server is read-only$/);
  // Putting the buffers back detaches their servers for a moment; the next request finds them.
  await refused('a.server', { line: 1, symbol: 'fixed' }, /^Error: server: there is nothing to rename there$/);
  await chmod(join(f.directory, 'b.server'), 0o644);
  await f.nvim.lua('local b = vim.fn.bufadd(...); vim.fn.bufload(b); vim.api.nvim_buf_set_lines(b, 0, -1, false, { "x typed" })', [join(f.directory, 'b.server')]);
  await refused('a.server', { line: 1, symbol: 'x' }, /b\.server has unsaved changes in Pi's Neovim$/);
  await refused('b.server', { line: 1, symbol: 'x' }, /its buffer in Pi's Neovim has unsaved changes/);
  assert.equal(await f.read('a.server'), 'fixed x\n');
  assert.equal(await f.read('b.server'), 'x\n');
  assert.deepEqual(await f.buffer('a.server'), [['fixed x'], false]);
  assert.deepEqual(await f.buffer('b.server'), [['x typed'], true]);

  for (const kind of ['error', 'outside', 'plain', 'stale']) await f.write(`c.${kind}`, 'x\n');
  await refused('c.error', { line: 1, symbol: 'x' }, /^Error: error: cannot rename this$/);
  await refused('c.outside', { line: 1, symbol: 'x' }, /^Error: \/etc\/hosts is outside the project$/);
  assert.deepEqual(await f.run('rename', 'c.plain', { line: 1, symbol: 'x', newName: 'y' }), ['No language server for c.plain can rename.']);
  assert.deepEqual(await f.run('rename', 'other.txt', { line: 1, symbol: 'x', newName: 'y' }).catch(error => error.message), 'no such file');
  // An edit made for another version of a file, be it version 0, is not applied; the server is asked again.
  assert.deepEqual(await f.run('rename', 'c.stale', { line: 1, symbol: 'x', newName: 'y' }), ['Renamed x to y in 1 file — stale', 'c.stale: lines 1 changed']);
  assert.equal(await f.read('c.stale'), 'y\n');
  assert.equal((await f.nvim.state()).blocking, false);
});

test('lists the code actions for a place and applies the one named', async t => {
  const f = await fixture(t);
  await f.write('a.server', 'b todo\na bad word\nc\n');
  // The server is told of the diagnostics on the lines asked about.
  await f.run('actions', 'a.server');
  assert.deepEqual(await f.run('actions', 'a.server', { line: 2 }), ['4 code actions for a.server:2 — server', '  Fix: bad word  [quickfix]', '  Upper-case the line  [refactor.rewrite]',
    '  Reverse the lines', '  Move the line to notes  [refactor.move]', '  +1 that cannot be applied here']);
  assert.deepEqual(await f.run('actions', 'a.server', { line: 1, kind: 'quickfix' }), ['1 code action of kind quickfix for a.server:1 — server', '  Remove the todo  [quickfix]']);
  assert.deepEqual(await f.run('actions', 'a.server', { line: 3, kind: 'quickfix' }), ['No code actions of kind quickfix for a.server:3']);
  assert.deepEqual(await f.run('actions', 'a.server', { kind: 'source' }), ['1 code action of kind source for a.server — server', '  Organize imports  [source.organizeImports]']);
  assert.equal(await f.read('a.server'), 'b todo\na bad word\nc\n');

  const refused = (options, pattern) => assert.rejects(f.run('apply', 'a.server', options), pattern);
  await refused({ line: 2, title: 'the line' }, /^Error: 3 code actions for a\.server:2 have "the line" in their title; give the full title of one, or a kind that only one has:\n  Upper-case the line  \[refactor\.rewrite\]\n  Reverse the lines\n  Move the line to notes  \[refactor\.move\]$/);
  await refused({ line: 2, title: 'Extract' }, /^Error: No code action for a\.server:2 has "Extract" in its title\. There are:\n  Fix: bad word/);
  await refused({ line: 2, title: 'Inline' }, /^Error: "Inline the line" is disabled: nothing to inline$/);
  await refused({ line: 3, kind: 'quickfix' }, /^Error: No code actions of kind quickfix for a\.server:3$/);
  assert.equal(await f.read('a.server'), 'b todo\na bad word\nc\n');

  // An edit that came with the action; one the server only gives once the action is chosen,
  // for the text pointed at; and a command, whose edit the server sends back by itself.
  assert.deepEqual(await f.run('apply', 'a.server', { line: 2, title: 'fix: bad' }), ['Applied "Fix: bad word" in 1 file — server', 'a.server: lines 2 changed']);
  assert.equal(await f.read('a.server'), 'b todo\na good word\nc\n');
  assert.deepEqual(await f.run('apply', 'a.server', { line: 2, symbol: 'good word', title: 'Upper-case good word' }), ['Applied "Upper-case good word" in 1 file — server', 'a.server: lines 2 changed']);
  assert.equal(await f.read('a.server'), 'b todo\na GOOD WORD\nc\n');
  assert.deepEqual(await f.run('apply', 'a.server', { title: 'Reverse the lines' }), ['Applied "Reverse the lines" in 1 file — server', 'a.server: lines 1, 2-3 changed']);
  assert.equal(await f.read('a.server'), 'c\na GOOD WORD\nb todo\n');
  assert.deepEqual(await f.run('apply', 'a.server', { kind: 'source.organizeImports' }), ['Applied "Organize imports" in 1 file — server', 'a.server: lines 1, 3 changed']);
  assert.equal(await f.read('a.server'), 'a GOOD WORD\nb todo\nc\n');

  // An action may create files as well as change them.
  assert.deepEqual(await f.run('apply', 'a.server', { line: 2, endLine: 3, title: 'Move the line' }), ['Applied "Move the line to notes" in 2 files — server',
    'a.server: lines 1 changed', 'a.server.notes: lines 1 changed', 'created a.server.notes']);
  assert.equal(await f.read('a.server'), 'a GOOD WORD\nc\n');
  assert.equal(await f.read('a.server.notes'), 'b todo\n');
  assert.equal((await f.nvim.state()).blocking, false);
});

test('edits a command has the server send are held to the same rules', async t => {
  const f = await fixture(t);
  const apply = title => f.run('apply', 'a.odd', { title });
  const reset = async () => { await f.write('a.odd', 'x\n'); await f.write('a.odd.other', 'x\n'); };
  await reset();
  // Two actions of one title are two candidates, not the first of them.
  await assert.rejects(apply('Same'), /^Error: 2 code actions for a\.odd have "Same" in their title; give the full title of one, or a kind that only one has:\n  Same\n  Same$/);
  // An edit that puts back what is there changes no file.
  assert.deepEqual(await apply('Nothing'), ['Applied "Nothing" — odd: it changed no files']);
  assert.deepEqual(await f.buffer('a.odd'), [['x'], false]);

  assert.deepEqual(await apply('Other'), ['Applied "Other" in 1 file — odd', 'a.odd.other: lines 1 changed']);
  await reset();
  // The action's own edit and the one its command sends afterwards are both written.
  assert.deepEqual(await apply('Both'), ['Applied "Both" in 2 files — odd', 'a.odd: lines 1 changed', 'a.odd.other: lines 1 changed']);
  assert.equal(await f.read('a.odd.other'), 'Y\n');
  await reset();

  await assert.rejects(apply('Elsewhere'), /^Error: \/etc\/hosts is outside the project$/);
  // An edit that comes long after its command has replied is refused, not left unsaved in a buffer.
  assert.deepEqual(await apply('Late'), ['Applied "Late" — odd: it changed no files']);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(await f.buffer('a.odd.other'), [['x'], false]);
  await f.nvim.lua('local b = vim.fn.bufadd(...); vim.api.nvim_buf_set_lines(b, 0, -1, false, { "typed" })', [join(f.directory, 'a.odd.other')]);
  await assert.rejects(apply('Other'), /a\.odd\.other has unsaved changes in Pi's Neovim$/);
  await assert.rejects(apply('Both'), /a\.odd\.other has unsaved changes in Pi's Neovim$/);
  assert.deepEqual(await f.buffer('a.odd.other'), [['typed'], true]);
  assert.deepEqual(await f.buffer('a.odd'), [['x'], false]);
  assert.equal(await f.read('a.odd'), 'x\n');
  assert.equal(await f.read('a.odd.other'), 'x\n');
});
