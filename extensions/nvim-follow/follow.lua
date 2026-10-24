-- Installs `remote.nvim_follow.show`, once for each attachment: sent with every change, this
-- would be sent and compiled each time. It runs through nvim-remote, with `remote` in scope.
--
-- show(path, ranges, ms, group, cursor, reread) shows `path` in the editor at `ranges`
-- ({ first, last } lines), highlighted in `group` for `ms`, with the cursor at `cursor`
-- ({ line, byte column }) or else the first range's start. `reread` is for a file that
-- changed: a buffer already loaded is read again. Returns what happened, so a file left
-- alone can be told from one shown.

-- This attachment's own highlights, apart from what other features put in remote.ns, and
-- gone with it.
local state = remote.nvim_follow
if not state then
  state = { ns = vim.api.nvim_create_namespace('nvim-follow.' .. remote.channel), shown = {} }
  remote.nvim_follow = state
  remote.on_detach(function()
    for _, b in ipairs(vim.api.nvim_list_bufs()) do vim.api.nvim_buf_clear_namespace(b, state.ns, 0, -1) end
  end)
end

function state.show(path, ranges, ms, group, cursor, reread)
  if not vim.uv.fs_stat(path) then return 'missing' end

  -- The buffer holding the file: by its name, which it nearly always has, else by where its
  -- name really leads (a symlink, say). Where a name leads is asked once for each.
  local function find(matches)
    return vim.iter(vim.api.nvim_list_bufs()):find(function(b)
      local name = vim.api.nvim_buf_get_name(b)
      return name ~= '' and matches(name)
    end)
  end
  local buf = find(function(name) return name == path end)
  if not buf then
    state.real = state.real or {}
    local function real(name)
      if state.real[name] == nil then state.real[name] = vim.uv.fs_realpath(name) or name end
      return state.real[name]
    end
    local target = vim.uv.fs_realpath(path) or path
    buf = find(function(name) return real(name) == target end)
  end
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

  -- keepjumps and keepalt: <C-o> and <C-^> stay the user's, not a trail of Pi's files. Each
  -- read from disk runs filetype detection, parsing and the language servers again, so a file
  -- is read once at most: when it is opened, or when one already loaded has changed.
  local loaded = buf ~= nil and vim.api.nvim_buf_is_loaded(buf)
  local ok, err = pcall(vim.api.nvim_win_call, win, function()
    if not buf then return vim.cmd('keepjumps keepalt edit ' .. vim.fn.fnameescape(path)) end
    if vim.api.nvim_win_get_buf(win) ~= buf then vim.cmd('keepjumps keepalt buffer ' .. buf) end
    if loaded and reread then vim.cmd('keepjumps keepalt edit') end
  end)
  if not ok then return err end

  buf = vim.api.nvim_win_get_buf(win)
  vim.api.nvim_set_hl(0, 'PiFollow', { link = 'IncSearch', default = true })
  vim.api.nvim_set_hl(0, 'PiFollowRead', { link = 'Visual', default = true })
  vim.api.nvim_buf_clear_namespace(buf, state.ns, 0, -1)
  local count = vim.api.nvim_buf_line_count(buf)
  for _, range in ipairs(ranges) do
    vim.api.nvim_buf_set_extmark(buf, state.ns, math.min(range[1], count) - 1, 0,
      { end_row = math.min(range[2], count), hl_group = group or 'PiFollow', hl_eol = true, strict = false })
  end
  -- Only the latest change to a buffer clears it, so a quick second change keeps its highlight;
  -- counted by buffer, so a change to another file does not stop this one clearing.
  state.shown[buf] = (state.shown[buf] or 0) + 1
  local shown = state.shown[buf]
  vim.defer_fn(function()
    if state.shown[buf] == shown and vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_clear_namespace(buf, state.ns, 0, -1) end
  end, ms)

  if cursor == vim.NIL then cursor = nil end
  cursor = cursor or (ranges[1] and { ranges[1][1], 0 })
  if cursor then
    local line = math.max(1, math.min(cursor[1], count))
    local text = vim.api.nvim_buf_get_lines(buf, line - 1, line, true)[1]
    -- In normal mode the cursor sits on a character, so the last one is as far as it goes.
    vim.api.nvim_win_set_cursor(win, { line, math.max(0, math.min(cursor[2], #text - 1)) })
    -- Every change in view when they fit, the span from the first to the last centered, the
    -- cursor on the first kept 'scrolloff' lines from the top; otherwise the first, centered.
    local top, bottom = line, line
    for _, range in ipairs(ranges) do
      top, bottom = math.min(top, math.min(range[1], count)), math.max(bottom, math.min(range[2], count))
    end
    local height = vim.api.nvim_win_get_height(win)
    local scrolloff = vim.wo[win].scrolloff
    if scrolloff < 0 then scrolloff = vim.o.scrolloff end
    scrolloff = math.min(scrolloff, math.floor((height - 1) / 2))
    local lowest, highest = math.max(1, bottom - height + 1), math.max(1, line - scrolloff)
    vim.api.nvim_win_call(win, function()
      if bottom > top and lowest <= highest then
        local centered = math.floor((top + bottom + 1 - height) / 2)
        vim.fn.winrestview({ topline = math.max(lowest, math.min(highest, centered)) })
      else
        vim.cmd('normal! zz')
      end
    end)
  end
  return 'shown'
end
