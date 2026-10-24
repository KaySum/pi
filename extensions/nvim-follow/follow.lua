-- Show `path` in the editor at its changed `ranges` ({ first, last } lines), highlighted for
-- `ms`. Runs through nvim-remote, with `remote` in scope. Returns what happened, so a file
-- left alone can be told from one shown.
local path, ranges, ms = ...

-- This attachment's own highlights, apart from what other features put in remote.ns, and
-- gone with it.
local state = remote.nvim_follow
if not state then
  state = { ns = vim.api.nvim_create_namespace('nvim-follow.' .. remote.channel), shown = 0 }
  remote.nvim_follow = state
  remote.on_detach(function()
    for _, b in ipairs(vim.api.nvim_list_bufs()) do vim.api.nvim_buf_clear_namespace(b, state.ns, 0, -1) end
  end)
end

if not vim.uv.fs_stat(path) then return 'missing' end
local real = vim.uv.fs_realpath(path) or path

local buf = vim.iter(vim.api.nvim_list_bufs()):find(function(b)
  local name = vim.api.nvim_buf_get_name(b)
  return name ~= '' and (vim.uv.fs_realpath(name) or name) == real
end)
-- Reloading would throw away the user's unsaved work.
if buf and vim.bo[buf].modified then return 'modified' end

-- The window the user is in is theirs while they type: it is used only in normal mode, and
-- only when there is no other. Otherwise: one showing the file, the one they came from, any.
local current = vim.api.nvim_get_current_win()
local typing = vim.api.nvim_get_mode().mode ~= 'n'
local function usable(win)
  if vim.bo[vim.api.nvim_win_get_buf(win)].buftype ~= '' then return false end
  if vim.api.nvim_win_get_config(win).relative ~= '' then return false end
  return win ~= current or not typing
end
local wins = vim.tbl_filter(usable, vim.api.nvim_tabpage_list_wins(0))
local others = vim.tbl_filter(function(w) return w ~= current end, wins)
local previous = vim.fn.win_getid(vim.fn.winnr('#'))
local win = vim.iter(wins):find(function(w) return w ~= current and vim.api.nvim_win_get_buf(w) == buf end)
  or (vim.tbl_contains(others, previous) and previous)
  or others[1]
  or (vim.tbl_contains(wins, current) and current)
if not win then return 'no window' end

-- keepjumps and keepalt: <C-o> and <C-^> stay the user's, not a trail of Pi's files.
local ok, err = pcall(vim.api.nvim_win_call, win, function()
  vim.cmd('keepjumps keepalt edit ' .. vim.fn.fnameescape(path))
  -- Switching to a buffer already loaded does not reread it.
  vim.cmd('keepjumps keepalt edit')
end)
if not ok then return err end

buf = vim.api.nvim_win_get_buf(win)
vim.api.nvim_set_hl(0, 'PiFollow', { link = 'IncSearch', default = true })
vim.api.nvim_buf_clear_namespace(buf, state.ns, 0, -1)
local count = vim.api.nvim_buf_line_count(buf)
for _, range in ipairs(ranges) do
  vim.api.nvim_buf_set_extmark(buf, state.ns, math.min(range[1], count) - 1, 0,
    { end_row = math.min(range[2], count), hl_group = 'PiFollow', hl_eol = true, strict = false })
end
-- Only the latest change's timer clears, so a quick second change keeps its highlight.
state.shown = state.shown + 1
local shown = state.shown
vim.defer_fn(function()
  if state.shown == shown and vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_clear_namespace(buf, state.ns, 0, -1) end
end, ms)

if ranges[1] then
  vim.api.nvim_win_set_cursor(win, { math.min(ranges[1][1], count), 0 })
  vim.api.nvim_win_call(win, function() vim.cmd('normal! zz') end)
end
return 'shown'
