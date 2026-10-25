-- Installs `remote.nvim_view`, once for each attachment: a snapshot of what the user sees
-- (the current tab's splits and floats, and the buffers in them), sent to Pi as
-- `nvim-view:changed` whenever it changes. What is not on screen (other tabs' windows, hidden
-- buffers) is not in it. It runs through nvim-remote, with `remote` in scope.

-- A view goes as soon as the editor is free after a change: a burst (a split opens: WinNew,
-- WinEnter, BufEnter, WinResized…) all fires before then, and makes one. While changes keep
-- coming (typing, scrolling), one goes at most every INTERVAL_MS, and none is held back
-- longer. Sent only if it differs from the last.
local INTERVAL_MS = 30
local EVENTS = {
	"WinNew", "WinClosed", "WinEnter", "WinResized", "WinScrolled",
	"BufEnter", "BufAdd", "BufNew", "BufDelete", "BufUnload", "BufHidden", "BufWipeout",
	"BufWinEnter", "BufWinLeave",
	"BufModifiedSet", "BufFilePost", "BufReadPost", "BufWritePost", "FileType",
	"TabNew", "TabClosed", "TabEnter", "VimResized", "ModeChanged", "DirChanged",
	"TermOpen", "TermClose", "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI",
	"OptionSet", "LspAttach", "LspDetach", "FocusGained", "FocusLost",
}
-- Window options that change what a window shows, or how much of it.
local OPTIONS = {
	"wrap", "number", "relativenumber", "signcolumn", "foldcolumn", "cursorline",
	"scrolloff", "sidescrolloff", "list", "diff", "spell", "conceallevel", "colorcolumn",
}

local state = remote.nvim_view
if state then
	return
end
-- `sent`: the last snapshot sent; `count`: how many; `built`: how long the last took, in ms.
state = { count = 0 }
remote.nvim_view = state

-- Buffer options through Vimscript: `vim.bo` and nvim_get_option_value take some 30 times as
-- long, which with many buffers is most of a snapshot.
local function option(buf, name)
	return vim.fn.getbufvar(buf, "&" .. name)
end

local function kind(win, buf, config, info)
	if config.relative ~= "" then
		return "float"
	end
	local buftype = option(buf, "buftype")
	if buftype == "quickfix" then
		return info.loclist == 1 and "loclist" or "quickfix"
	end
	return buftype == "" and "normal" or buftype
end

-- `winlayout()`'s tree, as { split = 'row' | 'col', children } and { win }.
local function layout(node)
	if node[1] == "leaf" then
		return { win = node[2] }
	end
	return { split = node[1], children = vim.tbl_map(layout, node[2]) }
end

-- What a window shows: its last line, even if only in part; each line on screen, top to
-- bottom, with the screen row its text starts on and the rows it takes, a closed fold as one
-- with the last line it hides; and how many rows are not empty.
local function shown(win, info, buf, view)
	local count = vim.api.nvim_buf_line_count(buf)
	-- Neovim's botline is the last line shown whole: with wrap, the one below may show its
	-- start in the rows left.
	local botline = info.botline
	if botline < count and vim.o.display ~= "" and vim.fn.screenpos(win, botline + 1, 1).row ~= 0 then
		botline = botline + 1
	end
	-- Filler above the top line is measured apart: only the part scrolled into view shows.
	local lines, line, top, bottom = {}, info.topline, info.winrow + view.topfill, info.winrow + info.height
	vim.api.nvim_win_call(win, function()
		while line <= botline and top < bottom do
			local fold = vim.fn.foldclosedend(line)
			local last = fold ~= -1 and fold or line
			local height = vim.api.nvim_win_text_height(win, {
				start_row = line - 1,
				end_row = last - 1,
				start_vcol = line == info.topline and view.skipcol or nil,
			})
			-- Virtual or filler lines above it push its text down; only then is it worth asking.
			local row = height.fill > 0 and vim.fn.screenpos(win, line, 1).row or 0
			row = row ~= 0 and row or top
			-- A line concealed whole (`conceal_lines`) takes no row: it is not on screen.
			if height.all > height.fill then
				table.insert(lines, {
					line = line,
					row = row,
					rows = math.min(height.all - height.fill, bottom - row),
					fold = fold ~= -1 and fold or nil,
				})
			end
			line, top = last + 1, top + height.all
		end
	end)
	-- Virtual lines above the next line take rows even when its text is not on screen, and
	-- those below the last line are only counted to the end.
	local rows = vim.api.nvim_win_text_height(win, {
		start_row = info.topline - 1,
		end_row = botline < count and botline or nil,
		start_vcol = view.skipcol,
	}).all
	return botline, lines, math.min(rows + view.topfill, info.height)
end

-- Where the cursor is on screen: on a tab, its last cell. With inline virtual text just before
-- it, Neovim gives a column as if the line did not wrap; wrapped here.
local function screen_cursor(win, info, cursor)
	local screen = vim.fn.screenpos(win, cursor[1], cursor[2] + 1)
	if screen.row == 0 then
		return nil
	end
	local left, width = info.wincol + info.textoff, info.width - info.textoff
	local past = screen.curscol - left
	if past < width or width <= 0 or not vim.wo[win].wrap then
		return { screen.row, screen.curscol }
	end
	return { screen.row + math.floor(past / width), left + past % width }
end

local function window(win, current, previous, cwd)
	local buf = vim.api.nvim_win_get_buf(win)
	local config = vim.api.nvim_win_get_config(win)
	local info = vim.fn.getwininfo(win)[1]
	local cursor = vim.api.nvim_win_get_cursor(win)
	local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
	local options = {}
	for _, name in ipairs(OPTIONS) do
		options[name] = vim.wo[win][name]
	end
	local botline, lines, rows = shown(win, info, buf, view)
	return {
		id = win,
		number = info.winnr,
		buf = buf,
		kind = kind(win, buf, config, info),
		focused = win == current or nil,
		previous = win == previous or nil,
		pi = buf == remote.terminal or nil,
		row = info.winrow,
		col = info.wincol,
		width = info.width,
		height = info.height,
		textWidth = info.width - info.textoff,
		textOff = info.textoff,
		topline = info.topline,
		botline = botline,
		rows = rows,
		shown = lines,
		leftcol = view.leftcol,
		skipcol = view.skipcol,
		cursor = { cursor[1], cursor[2] },
		screenCursor = screen_cursor(win, info, cursor),
		-- getcwd() for a window is slow; most have no directory of their own, nor their tab.
		cwd = (vim.fn.haslocaldir(info.winnr, info.tabnr) ~= 0 or vim.fn.haslocaldir(-1, info.tabnr) ~= 0)
				and vim.fn.getcwd(info.winnr, info.tabnr)
			or cwd,
		float = config.relative ~= "" and {
			relative = config.relative,
			zindex = config.zindex,
			focusable = config.focusable,
			border = config.border,
		} or nil,
		options = options,
	}
end

local function buffer(buf)
	local loaded = vim.api.nvim_buf_is_loaded(buf)
	local lines = loaded and vim.api.nvim_buf_line_count(buf) or nil
	return {
		id = buf,
		name = vim.api.nvim_buf_get_name(buf),
		filetype = option(buf, "filetype"),
		buftype = option(buf, "buftype"),
		listed = option(buf, "buflisted") == 1,
		loaded = loaded,
		modified = option(buf, "modified") == 1,
		readonly = option(buf, "readonly") == 1,
		modifiable = option(buf, "modifiable") == 1,
		lines = lines,
		bytes = lines and vim.api.nvim_buf_get_offset(buf, lines) or nil,
		changedtick = vim.api.nvim_buf_get_changedtick(buf),
		-- Loading vim.lsp to ask would cost more than the rest; not loaded, nothing is attached.
		lsp = package.loaded["vim.lsp"] and vim.tbl_map(function(client)
			return client.name
		end, vim.lsp.get_clients({ bufnr = buf })) or {},
		pi = buf == remote.terminal or nil,
	}
end

-- The user's window: the focused one unless it is Pi's terminal or another like it, else the
-- one they came from, else any showing a file.
local function yours(windows)
	local order = {}
	for _, win in ipairs(windows) do
		table.insert(order, win.focused and 1 or win.previous and 2 or 3)
	end
	local best
	for i, win in ipairs(windows) do
		if win.kind == "normal" and (not best or order[i] < order[best]) then
			best = i
		end
	end
	return best and windows[best].id or nil
end

--- What the user sees now: the current tab's windows (but floats it hides), the buffers they
--- show, and the tabs the tabline names.
function state.snapshot()
	local current = vim.api.nvim_get_current_win()
	local previous = vim.fn.win_getid(vim.fn.winnr("#"))
	local cwd = vim.fn.getcwd(-1, -1)
	local windows, buffers, showing = {}, {}, {}
	for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
		if not vim.api.nvim_win_get_config(win).hide then
			local entry = window(win, current, previous, cwd)
			table.insert(windows, entry)
			if not showing[entry.buf] then
				showing[entry.buf] = {}
				table.insert(buffers, buffer(entry.buf))
			end
			table.insert(showing[entry.buf], win)
		end
	end
	for _, entry in ipairs(buffers) do
		entry.windows = showing[entry.id]
	end
	local tabs = {}
	for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
		table.insert(tabs, {
			id = tab,
			number = vim.api.nvim_tabpage_get_number(tab),
			focused = tab == vim.api.nvim_get_current_tabpage() or nil,
		})
	end
	local mode = vim.api.nvim_get_mode()
	return {
		editor = {
			columns = vim.o.columns,
			lines = vim.o.lines,
			cmdheight = vim.o.cmdheight,
			mode = mode.mode,
			blocking = mode.blocking,
			cwd = cwd,
			focused = state.focused,
		},
		focus = {
			tab = vim.api.nvim_get_current_tabpage(),
			win = current,
			buf = vim.api.nvim_get_current_buf(),
			previous = previous ~= 0 and previous or nil,
		},
		you = yours(windows),
		pi = showing[remote.terminal] and { buf = remote.terminal, windows = showing[remote.terminal] } or nil,
		tabs = tabs,
		layout = layout(vim.fn.winlayout()),
		windows = windows,
		buffers = buffers,
	}
end

--- A snapshot now, and whether it differs from the last sent: if so, it is the last sent.
function state.current()
	local start = vim.uv.hrtime()
	local view = state.snapshot()
	state.built = (vim.uv.hrtime() - start) / 1e6
	if vim.deep_equal(view, state.sent) then
		return view, false
	end
	state.sent, state.count = view, state.count + 1
	return view, true
end

-- Send a snapshot, if it is not the one sent last.
local function send()
	local view, changed = state.current()
	if changed then
		remote.notify("nvim-view:changed", view, { count = state.count, built = state.built })
	end
end

-- What changes on screen with no autocommand to say so: a float's config, a cursor in a
-- window not current, a buffer shown but not current edited, all by the API. After each
-- command, while idle, this is compared; a cheap look, unlike a snapshot, which here would
-- loop. Everything `window` gives of a float is in it; buffers are summed, their changedticks
-- only rising.
-- Which line is on which row: folds opened or closed and virtual lines placed change it, and
-- fire no event. Each line's rows (virtual lines below one count as the next's), through the
-- one below the last on screen.
local function placement(win)
	local count = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
	local line, last = vim.fn.line("w0", win), math.min(vim.fn.line("w$", win) + 1, count)
	return vim.api.nvim_win_call(win, function()
		local parts = { line }
		while line <= last do
			local fold = vim.fn.foldclosedend(line)
			-- Virtual lines below the buffer's last line are only counted to the end.
			local height = vim.api.nvim_win_text_height(win, { start_row = line - 1, end_row = line < count and line - 1 or nil })
			table.insert(parts, fold ~= -1 and -fold or height.all)
			line = fold ~= -1 and fold + 1 or line + 1
		end
		return table.concat(parts, ",")
	end)
end

local function unreported()
	local parts = {}
	for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
		local cursor = vim.api.nvim_win_get_cursor(win)
		table.insert(parts, win .. ":" .. cursor[1] .. ":" .. cursor[2])
		table.insert(parts, placement(win))
		local config = vim.api.nvim_win_get_config(win)
		if config.relative ~= "" then
			local row, col = unpack(vim.api.nvim_win_get_position(win))
			table.insert(parts, table.concat({
				row, col, config.width, config.height, config.relative, tostring(config.zindex),
				tostring(config.focusable), vim.inspect(config.border), tostring(config.hide),
			}, ","))
		end
	end
	-- The buffers on screen: one joins them by being shown, which window events report.
	local ticks, loaded = 0, 0
	for _, entry in ipairs(state.sent and state.sent.buffers or {}) do
		local buf = entry.id
		if vim.api.nvim_buf_is_valid(buf) then
			ticks = ticks + vim.api.nvim_buf_get_changedtick(buf)
			if vim.api.nvim_buf_is_loaded(buf) then
				loaded = loaded + buf
			end
		end
	end
	table.insert(parts, ticks .. ":" .. loaded)
	return table.concat(parts, ";")
end

state.timer = vim.uv.new_timer()
remote.on_detach(function()
	state.closed = true -- A view already scheduled must not go to a channel that is gone.
	state.timer:stop()
	state.timer:close()
end)
local function changed()
	if state.pending then
		return -- The view to come will see this change too: it is made when it is sent.
	end
	state.pending = true
	local since = (vim.uv.hrtime() - (state.last or 0)) / 1e6
	state.timer:start(math.max(0, INTERVAL_MS - since), 0, vim.schedule_wrap(function()
		state.pending = false
		if not state.closed then
			state.last = vim.uv.hrtime()
			send()
		end
	end))
end
vim.api.nvim_create_autocmd("SafeState", {
	group = remote.group,
	callback = function()
		local now = unreported()
		if now ~= state.unreported then
			state.unreported = now
			changed()
		end
	end,
})
vim.api.nvim_create_autocmd(EVENTS, {
	group = remote.group,
	callback = function(ev)
		if ev.event == "FocusGained" or ev.event == "FocusLost" then
			state.focused = ev.event == "FocusGained"
		end
		changed()
	end,
})
send()
