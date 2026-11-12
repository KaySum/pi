-- The editor's side of nvim-remote: a context for each attached Pi, and whatever a Pi creates
-- through it removed when that Pi goes, however it goes. Every Pi that attaches runs this
-- again; the state survives and only the functions are replaced, so several Pis can share
-- one editor. `NAME` carries a version: Pis whose state would not fit together each keep
-- their own, rather than one replacing functions the other's state was not made for.
local NAME = ...
local M = type(package.loaded[NAME]) == 'table' and package.loaded[NAME] or {}
package.loaded[NAME] = M
M.contexts = M.contexts or {}

local SWEEP_MS = 500

local function alive(chan) return next(vim.api.nvim_get_chan_info(chan)) ~= nil end

-- Notify the Pi on `chan`. Once the editor has closed its channel, Neovim refuses at once,
-- though the channel is still listed (`alive`) for a while: the Pi is then detached on the next
-- tick, not at the next sweep, and nothing is raised at the user. Other errors are raised.
local function send(chan, ...)
  local ok, err = pcall(vim.rpcnotify, chan, ...)
  if ok then return true end
  if not tostring(err):find('Invalid channel', 1, true) then error(err, 0) end
  vim.schedule(function() M.detach(chan) end)
  return false
end

-- The terminal buffer whose job is Pi or one of its ancestors (a shell, sidekick's wrapper).
local function terminal_of(pid)
  local jobs = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].buftype == 'terminal' then
      local ok, job = pcall(vim.fn.jobpid, vim.bo[buf].channel)
      if ok then jobs[job] = buf end
    end
  end
  while pid and pid > 1 do
    if jobs[pid] then return jobs[pid] end
    local proc = vim.api.nvim_get_proc(pid)
    pid = proc and proc.ppid
  end
end

local function announce(name, ctx)
  vim.api.nvim_exec_autocmds('User', {
    pattern = 'NvimRemote' .. name, modeline = false,
    data = { channel = ctx.channel, pid = ctx.pid, cwd = ctx.cwd, terminal = ctx.terminal },
  })
end

-- Neovim says nothing when a channel closes, so a Pi that crashed is found by looking.
function M._sweep()
  for chan in pairs(M.contexts) do
    if not alive(chan) then M.detach(chan) end
  end
  if next(M.contexts) == nil and M._timer then
    M._timer:stop()
    M._timer:close()
    M._timer = nil
  end
end

function M.attach(chan, info)
  -- One whose channel the editor closed is only found by looking: a reconnect looks first, so
  -- that it never runs beside what it replaces.
  M._sweep()
  local ctx = {
    channel = chan, pid = info.pid, cwd = info.cwd, terminal = terminal_of(info.pid), cleanups = {},
    group = vim.api.nvim_create_augroup('nvim-remote.' .. chan, { clear = true }),
    ns = vim.api.nvim_create_namespace('nvim-remote.' .. chan),
  }
  --- Run `fn` when this Pi detaches, quits or crashes; the last registered runs first.
  function ctx.on_detach(fn) table.insert(ctx.cleanups, fn) end
  --- Send this Pi a notification, received with `on(name, handler)`.
  function ctx.notify(name, ...) send(chan, name, ...) end
  M.contexts[chan] = ctx
  if not M._timer then
    M._timer = vim.uv.new_timer()
    M._timer:start(SWEEP_MS, SWEEP_MS, vim.schedule_wrap(function() M._sweep() end))
  end
  announce('Attach', ctx)
  return { terminal = ctx.terminal }
end

--- Undo what the Pi on `chan` set up. Returns the errors of cleanups that failed.
function M.detach(chan)
  local ctx = M.contexts[chan]
  if not ctx then return {} end
  M.contexts[chan] = nil
  local errors = {}
  for i = #ctx.cleanups, 1, -1 do
    local ok, err = pcall(ctx.cleanups[i])
    if not ok then errors[#errors + 1] = tostring(err) end
  end
  pcall(vim.api.nvim_del_augroup_by_id, ctx.group)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    vim.api.nvim_buf_clear_namespace(buf, ctx.ns, 0, -1)
  end
  announce('Detach', ctx)
  return errors
end

local function context(chan)
  return M.contexts[chan] or error(('Pi on channel %d is not attached'):format(chan), 0)
end

-- `code` runs as the body of a function receiving `args` as `...`, with `remote` in scope.
-- The header shares the first line, so line numbers in errors are the caller's.
function M.run(chan, code, args)
  local ctx = context(chan)
  local chunk, err = loadstring('local remote = ... return function(...) ' .. code .. '\nend', '=nvim-remote')
  if not chunk then error(err, 0) end
  return chunk(ctx)(unpack(args))
end

function M.autocmd(chan, id, events, opts)
  local ctx = context(chan)
  opts = vim.tbl_extend('force', opts, { group = ctx.group })
  opts.callback = function(ev)
    local event = { event = ev.event, buf = ev.buf, file = ev.file, match = ev.match, id = ev.id }
    -- Data that cannot cross the socket (functions, say) is left out rather than lost with the rest.
    if not pcall(send, chan, 'nvim-remote:autocmd', id, vim.tbl_extend('force', event, { data = ev.data })) then
      send(chan, 'nvim-remote:autocmd', id, event)
    end
  end
  return vim.api.nvim_create_autocmd(events, opts)
end

return M
