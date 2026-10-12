import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from '../nvim-service/service.mjs';
import { openNvim } from '../nvim-service/nvim.mjs';
import { format, validate } from './core.mjs';

// Stands in for conform.nvim: a file's extension names its formatters (`a.upper`,
// `b.upper_trim`); with none, it falls back to the language servers.
const CONFORM = `vim.o.confirm = true
package.preload.conform = function()
  local run = { upper = string.upper, trim = vim.trim }
  local function names(buf)
    local list = {}
    for name in vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ':e'):gmatch('[^_]+') do
      if run[name] or name == 'broken' or name == 'eol' then table.insert(list, { name = name }) end
    end
    return list
  end
  return {
    list_formatters_to_run = function(buf)
      local list = names(buf)
      return list, #list == 0 and #vim.lsp.get_clients({ bufnr = buf, method = 'textDocument/formatting' }) > 0
    end,
    format = function(opts, callback)
      local list = names(opts.bufnr)
      if #list == 0 then vim.lsp.buf.format({ bufnr = opts.bufnr, async = false, timeout_ms = opts.timeout_ms }); return callback() end
      local lines = vim.api.nvim_buf_get_lines(opts.bufnr, 0, -1, false)
      for _, formatter in ipairs(list) do
        if formatter.name == 'eol' then vim.bo[opts.bufnr].endofline = true; vim.bo[opts.bufnr].modified = true; return callback() end
        if not run[formatter.name] then
          vim.api.nvim_buf_set_lines(opts.bufnr, 0, 1, false, { 'half done' })
          return callback('broken exited with\\n  code 1')
        end
        lines = vim.tbl_map(run[formatter.name], lines)
      end
      if not vim.deep_equal(lines, vim.api.nvim_buf_get_lines(opts.bufnr, 0, -1, false)) then vim.api.nvim_buf_set_lines(opts.bufnr, 0, -1, false, lines) end
      callback()
    end,
  }
end`;
// Language servers inside Neovim, attaching a moment after a file loads and named by its
// extension (`a.server`, `b.server_error`): `server` upper-cases the file it is asked
// about, `plain` cannot format, `error` answers with an error and `hang` never answers.
const SERVERS = `local function server(kind)
  return function()
    local closing = false
    return {
      request = function(method, params, callback)
        if method == 'initialize' then callback(nil, { capabilities = { documentFormattingProvider = kind ~= 'plain' } })
        elseif method == 'textDocument/formatting' and kind == 'hang' then
        elseif method == 'textDocument/formatting' and kind == 'error' then callback({ code = -32603, message = 'cannot format this' })
        elseif method == 'textDocument/formatting' then
          local lines = vim.api.nvim_buf_get_lines(vim.uri_to_bufnr(params.textDocument.uri), 0, -1, false)
          callback(nil, { { range = { start = { line = 0, character = 0 }, ['end'] = { line = #lines, character = 0 } }, newText = table.concat(lines, '\\n'):upper() .. '\\n' } })
        else callback(nil, vim.NIL) end
        return true, 1
      end,
      notify = function() return true end,
      is_closing = function() return closing end,
      terminate = function() closing = true end,
    }
  end
end
vim.api.nvim_create_autocmd('BufReadPost', { callback = function(ev)
  vim.defer_fn(function()
    for kind in vim.fn.fnamemodify(ev.file, ':e'):gmatch('[^_]+') do
      if ({ server = 1, plain = 1, error = 1, hang = 1 })[kind] then vim.lsp.start({ name = kind, cmd = server(kind) }, { bufnr = ev.buf }) end
    end
  end, 150)
end })`;

async function fixture(t, init = `${CONFORM}\n${SERVERS}`) {
  const directory = await realpath(await mkdtemp('/tmp/pi-format-test-'));
  await writeFile(join(directory, 'init.lua'), init);
  const service = launch({ cwd: directory, init: join(directory, 'init.lua'), graceMs: 100, killMs: 300 });
  const nvim = await openNvim(await service.ready);
  t.after(async () => { nvim.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, nvim,
    write: (name, text) => writeFile(join(directory, name), text),
    read: name => readFile(join(directory, name), 'utf8'),
    run: async (files, options) => (await format(nvim, { files, ...options }, directory)).split('\n'),
  };
}

test('rejects bad arguments before touching the editor', () => {
  for (const params of [undefined, {}, { files: [] }, { files: Array(33).fill('a') }, { files: ['a\0'] }, { files: [1] },
    { files: ['a'], timeoutMs: 99 }, { files: ['a'], timeoutMs: 1.5 }]) {
    assert.throws(() => validate(params));
  }
  assert.deepEqual(validate({ files: ['a'] }), { files: ['a'], timeoutMs: 10000 });
});

test('formats files on disk, says which lines changed, and leaves the rest alone', async t => {
  const f = await fixture(t);
  await f.write('a.upper', 'ONE\ntwo\nTHREE\nFOUR\nfive\nsix\n');
  await f.write('b.upper_trim', '  x  \n');
  await f.write('done.upper', 'FINE\n');
  await f.write('notes.txt', 'as it is\n');
  assert.deepEqual(await f.run(['a.upper', 'b.upper_trim', 'done.upper', 'notes.txt', 'nope.upper', '.', 'a.upper', '/etc/hosts']), [
    'a.upper: formatted, lines 2, 5-6 changed — upper', 'b.upper_trim: formatted, lines 1 changed — upper, trim', 'done.upper: already formatted — upper',
    'notes.txt: no formatter for this file', 'nope.upper: no such file', `${f.directory}: not a regular file`, '/etc/hosts: not formatted: the file is read-only']);
  assert.equal(await f.read('a.upper'), 'ONE\nTWO\nTHREE\nFOUR\nFIVE\nSIX\n');
  assert.equal(await f.read('b.upper_trim'), 'X\n');
  assert.equal(await f.read('notes.txt'), 'as it is\n');

  // The file is formatted as it is on disk now, not as the editor last saw it.
  await f.write('a.upper', 'ONE\nnew\n');
  assert.deepEqual(await f.run(['a.upper']), ['a.upper: formatted, lines 2 changed — upper']);
  assert.equal(await f.read('a.upper'), 'ONE\nNEW\n');
  assert.deepEqual(await f.run(['a.upper']), ['a.upper: already formatted — upper']);

  // A change that leaves every line as it was is still a change to the file.
  await f.write('end.eol', 'ONE');
  assert.deepEqual(await f.run(['end.eol']), ['end.eol: formatted, lines 1 changed — eol']);
  assert.equal(await f.read('end.eol'), 'ONE\n');

  const many = Array.from({ length: 40 }, (_, i) => i % 2 ? `x${i}` : `X${i}`).join('\n');
  await f.write('many.upper', many);
  assert.deepEqual(await f.run(['many.upper']), [`many.upper: formatted, lines ${Array.from({ length: 12 }, (_, i) => 2 * i + 2).join(', ')}, +8 more changed — upper`]);
});

test('a formatter that fails, a read-only file and an unsaved buffer change nothing', async t => {
  const f = await fixture(t);
  await f.write('a.upper_broken', 'text\n');
  assert.deepEqual(await f.run(['a.upper_broken']), ['a.upper_broken: failed: broken exited with code 1 — upper, broken']);
  assert.equal(await f.read('a.upper_broken'), 'text\n');
  const buffer = name => f.nvim.lua('local b = vim.fn.bufadd(...); return { vim.api.nvim_buf_get_lines(b, 0, -1, false), vim.bo[b].modified }', [join(f.directory, name)]);
  assert.deepEqual(await buffer('a.upper_broken'), [['text'], false]);

  await f.write('locked.upper', 'text\n');
  await chmod(join(f.directory, 'locked.upper'), 0o444);
  assert.deepEqual(await f.run(['locked.upper']), ['locked.upper: not formatted: the file is read-only']);
  assert.equal(await f.read('locked.upper'), 'text\n');
  assert.deepEqual(await buffer('locked.upper'), [['text'], false]);

  await f.write('typed.upper', 'on disk\n');
  await f.nvim.lua('local b = vim.fn.bufadd(...); vim.fn.bufload(b); vim.api.nvim_buf_set_lines(b, 0, -1, false, { "typed" })', [join(f.directory, 'typed.upper')]);
  assert.deepEqual(await f.run(['typed.upper']), ["typed.upper: not formatted: its buffer in Pi's Neovim has unsaved changes"]);
  assert.equal(await f.read('typed.upper'), 'on disk\n');
  assert.deepEqual(await buffer('typed.upper'), [['typed'], true]);
  assert.equal((await f.nvim.state()).blocking, false);
});

for (const [setup, init] of [['conform falling back to them', undefined], ['no conform', SERVERS]]) {
  test(`language servers format what has no formatter of its own: ${setup}`, async t => {
    const f = await fixture(t, init);
    await f.write('a.server', 'one\ntwo\n');
    await f.write('b.plain', 'one\n');
    // The server attaches after the file loads, and again after it is reloaded: both are waited for.
    assert.deepEqual(await f.run(['a.server', 'b.plain']), ['a.server: formatted, lines 1-2 changed — server', 'b.plain: no formatter for this file']);
    assert.equal(await f.read('a.server'), 'ONE\nTWO\n');
    await f.write('a.server', 'ONE\nmore\n');
    assert.deepEqual(await f.run(['a.server']), ['a.server: formatted, lines 2 changed — server']);
    assert.deepEqual(await f.run(['a.server']), ['a.server: already formatted — server']);

    // A server that fails or never answers is a failure, and undoes what one before it did.
    // Not asked of the stand-in for conform, which would only be answering for itself.
    if (init === undefined) return;
    for (const name of ['c.error', 'd.server_error', 'e.hang']) await f.write(name, 'text\n');
    assert.deepEqual(await f.run(['c.error', 'd.server_error']), ['c.error: failed: error: cannot format this — error',
      'd.server_error: failed: error: cannot format this — server, error']);
    assert.match((await f.run(['e.hang'], { timeoutMs: 300 }))[0], /^e\.hang: failed: hang: timeout — hang$/);
    for (const name of ['c.error', 'd.server_error', 'e.hang']) assert.equal(await f.read(name), 'text\n');
  });
}
