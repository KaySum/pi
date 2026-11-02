-- Installs `remote.nvim_point`, once for each attachment: it shows the user a place in a file, in
-- their window (never Pi's terminal), its cursor there, leaving focus where it is. It runs
-- through nvim-remote, with `remote` in scope.

if remote.nvim_point then
	return
end
local point = {}
remote.nvim_point = point

-- The buffer of the file at `path`: loaded, as the user's own would be.
local function buffer(path)
	local stat = vim.uv.fs_stat(path)
	if vim.fn.bufexists(path) == 0 and not stat then
		error(("no such file: %s"):format(path), 0)
	elseif stat and stat.type ~= "file" then
		error(("not a file: %s"):format(path), 0)
	end
	local buf = vim.fn.bufadd(path)
	if not vim.api.nvim_buf_is_loaded(buf) then
		-- An existing swap file would otherwise stop the editor at a prompt.
		local shortmess = vim.o.shortmess
		vim.opt.shortmess:append("A")
		local ok, err = pcall(vim.fn.bufload, buf)
		vim.o.shortmess = shortmess
		if not ok then
			error(err, 0)
		end
	end
	return buf
end

local function shows_file(win)
	return win ~= 0
		and vim.api.nvim_win_is_valid(win)
		and vim.api.nvim_win_get_config(win).relative == ""
		and vim.bo[vim.api.nvim_win_get_buf(win)].buftype == ""
end

-- Where to show `buf`: a window of this tab showing it already, else the user's: the one they
-- are in unless it is Pi's terminal (or another like it), else the one they came from, else any
-- showing a file. Nil if none does.
local function window(buf)
	local wins = { vim.api.nvim_get_current_win(), vim.fn.win_getid(vim.fn.winnr("#")) }
	vim.list_extend(wins, vim.api.nvim_tabpage_list_wins(0))
	for _, win in ipairs(wins) do
		if shows_file(win) and vim.api.nvim_win_get_buf(win) == buf then
			return win
		end
	end
	for _, win in ipairs(wins) do
		if shows_file(win) then
			return win
		end
	end
end

-- The topline that leaves `rows` screen rows above `line`, folds and wrapping counted.
local function top_for(win, line, rows)
	local top = line
	while top > 1 do
		local above = vim.fn.foldclosed(top - 1)
		above = above ~= -1 and above or top - 1
		local height = vim.api.nvim_win_text_height(win, { start_row = above - 1, end_row = top - 2 }).all
		if height > rows then
			break
		end
		rows, top = rows - height, above
	end
	return top
end

-- Scroll, in the current window, so that `first`–`last` are on screen with `context` lines
-- around them: centered if they fit, else from the top.
local function reveal(win, first, last, context)
	local height = vim.api.nvim_win_get_height(win)
	local rows = vim.api.nvim_win_text_height(win, { start_row = first - 1, end_row = last - 1 }).all
	local above = rows + 2 * context <= height and math.floor((height - rows) / 2) or context
	vim.fn.winrestview({ topline = top_for(win, first, above), topfill = 0, skipcol = 0 })
end

--- Show `spec.path` at `spec.line` (to `spec.endLine`), the cursor at `spec.col` (0-based bytes;
--- else the line's first non-blank). Not while the user is busy: then `{ busy = mode }`. (At a
--- prompt this does not run: nvim-remote fails the call first.)
function point.show(spec)
	local mode = vim.api.nvim_get_mode().mode
	if not (mode == "n" or mode == "nt" or mode == "t") then
		return { busy = mode }
	end
	local buf = buffer(spec.path)
	local count = vim.api.nvim_buf_line_count(buf)
	local last = spec.endLine or spec.line
	if last > count then
		error(("line %d is past the end of %s, at %d"):format(last, spec.path, count), 0)
	end

	local win, opened = window(buf), false
	-- Where the user was goes in the window's jumplist, so <C-o> takes them back.
	local function jump()
		vim.api.nvim_win_call(win, function()
			vim.cmd("normal! m'")
		end)
	end
	if win and vim.api.nvim_win_get_buf(win) ~= buf then
		jump()
		-- Unsaved changes there, and 'hidden' off: rather than lose them, a split.
		if not pcall(vim.api.nvim_win_set_buf, win, buf) then
			win, opened = vim.api.nvim_open_win(buf, false, { split = "above", win = win }), true
		end
	elseif not win then
		-- Beside the window you are in, or if it floats (as some put Pi's terminal), one beneath.
		local beside = vim.api.nvim_get_current_win()
		if vim.api.nvim_win_get_config(beside).relative ~= "" then
			beside = vim.iter(vim.api.nvim_tabpage_list_wins(0)):find(function(other)
				return vim.api.nvim_win_get_config(other).relative == ""
			end)
		end
		win, opened = vim.api.nvim_open_win(buf, false, { split = "left", win = beside }), true
		-- Not the jumps of the window it split, Pi's terminal or another like it.
		vim.api.nvim_win_call(win, function()
			vim.cmd("clearjumps")
		end)
	elseif vim.api.nvim_win_get_cursor(win)[1] ~= spec.line then
		jump()
	end
	vim.bo[buf].buflisted = true

	return vim.api.nvim_win_call(win, function()
		local before = vim.fn.winsaveview()
		vim.cmd(("silent! %d,%dfoldopen!"):format(spec.line, last))
		-- On screen already, it is left where it is: the user knows where to look.
		local visible = vim.fn.line("w0") <= spec.line and last <= vim.fn.line("w$")
		-- As `^` would: the first non-blank, or the last character of a line of blanks.
		local text = vim.api.nvim_buf_get_lines(buf, spec.line - 1, spec.line, true)[1]
		local col = math.max(math.min(spec.col or (text:find("%S") or #text) - 1, #text - 1), 0)
		if col > 0 then
			col = col + vim.str_utf_start(text, col + 1) -- A character's first byte.
		end
		vim.api.nvim_win_set_cursor(win, { spec.line, col })
		if not visible then
			reveal(win, spec.line, last, spec.context or 3)
		end
		local after = vim.fn.winsaveview()
		return {
			win = win,
			buf = buf,
			opened = opened,
			scrolled = after.topline ~= before.topline or after.skipcol ~= before.skipcol,
		}
	end)
end
