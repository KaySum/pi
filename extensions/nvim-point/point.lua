-- Installs `remote.nvim_point`, once for each attachment: it shows the user a place in a file, in
-- their window (never Pi's terminal), its cursor there, leaving focus where it is unless asked. It runs
-- through nvim-remote, with `remote` in scope.

if remote.nvim_point then
	return
end
local point = {}
remote.nvim_point = point

-- What it shares with the other extensions: installed before this.
local kit = remote.kit

-- The buffer of `spec`: `spec.buf`, any but a terminal, or the file at `spec.path`. Loaded,
-- and what was done for it (see the kit's `load`).
local function buffer(spec)
	if spec.path then
		return kit.open(spec.path)
	elseif not vim.api.nvim_buf_is_valid(spec.buf) then
		error(("no buffer %d"):format(spec.buf), 0)
	elseif vim.bo[spec.buf].buftype == "terminal" then
		error(("buffer %d is a terminal"):format(spec.buf), 0)
	end
	return spec.buf, kit.load(spec.buf, true)
end

-- Where to show `buf`: a window of this tab showing it already, else the user's: the one they
-- are in unless it is Pi's terminal (or another like it), else the one they came from, else any
-- showing a file. Nil if none does.
local function window(buf)
	for _, win in ipairs(kit.windows()) do
		if vim.api.nvim_win_get_config(win).relative == "" and vim.api.nvim_win_get_buf(win) == buf then
			return win
		end
	end
	return kit.yours()
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
-- around them: as `how` says, "center", "top", or "minimal": just past the edge they were off,
-- the bottom one if `below` it. Too tall for the window, from their start.
local function reveal(win, first, last, context, how, below)
	local height = vim.api.nvim_win_get_height(win)
	context = math.min(context, math.floor((height - 1) / 2)) -- Leaving room for the lines.
	local rows = vim.api.nvim_win_text_height(win, { start_row = first - 1, end_row = last - 1 }).all
	local above = context
	if rows + 2 * context <= height then
		if how == "center" then
			above = math.floor((height - rows) / 2)
		elseif how == "minimal" and below then
			above = height - rows - context
		end
	end
	vim.fn.winrestview({ topline = top_for(win, first, above), topfill = 0, skipcol = 0 })
end

-- Where `match` is in `buf`: its lines, the space around them aside, each within one of the
-- buffer's, in order; the occurrence nearest `near`, the earlier on a tie. Its first line, its
-- last, and the byte column its text starts at; nil and why if it is not there.
local function find(buf, match, near)
	local needles = vim.tbl_map(vim.trim, vim.split(match, "\n", { plain = true }))
	while needles[#needles] == "" do
		table.remove(needles)
	end
	while needles[1] == "" do
		table.remove(needles, 1)
	end
	if #needles == 0 then
		return nil, "match is only space"
	end
	local lines, best = vim.api.nvim_buf_get_lines(buf, 0, -1, true), nil
	for i = 1, #lines - #needles + 1 do
		local start = lines[i]:find(needles[1], 1, true)
		local whole = start ~= nil
		for j = 2, whole and #needles or 0 do
			whole = lines[i + j - 1]:find(needles[j], 1, true) ~= nil
			if not whole then
				break
			end
		end
		if whole then
			if not best or math.abs(i - near) < math.abs(best[1] - near) then
				best = { i, i + #needles - 1, start - 1 }
			end
			if i >= near then
				break -- Any later is further.
			end
		end
	end
	return best
end

-- Whether a window of this tab shows `spec.buf`, or the file at `spec.path` by any name of it
-- (see the kit's `file`).
local function open_here(spec)
	local is = spec.path and kit.file(spec.path)
	for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
		local buf = vim.api.nvim_win_get_buf(win)
		if vim.api.nvim_win_get_config(win).relative == "" and (buf == spec.buf or is and is(buf)) then
			return true
		end
	end
	return false
end

-- Show `buf` in `win`; with `quiet`, leaving its jumplist and alternate file as they were.
local function enter(win, buf, quiet)
	kit.guarded(buf, function()
		if not quiet then
			return vim.api.nvim_win_set_buf(win, buf)
		end
		vim.api.nvim_win_call(win, function()
			vim.cmd(("keepalt keepjumps buffer %d"):format(buf))
		end)
	end)
end

--- Show `spec.path` (or `spec.buf`) at `spec.line` (to `spec.endLine`), the cursor at `spec.col`
--- (0-based bytes; else the line's first non-blank); or where `spec.match` is, nearest
--- `spec.line`. Not while the user is busy: then `{ shown = false, busy = mode }`. (At a prompt
--- this does not run: nvim-remote fails the call first.)
function point.show(spec)
	local busy = kit.busy()
	if busy then
		return { shown = false, busy = busy }
	elseif spec.open == false and not open_here(spec) then
		return { shown = false, closed = true } -- Neither loaded nor any window changed for it.
	end
	local buf, done = buffer(spec)
	local name = spec.path or ("buffer %d"):format(buf)
	-- Not left loaded (a swap file and all) for a file the user did not open.
	local function fail(message)
		kit.undo(buf, done)
		error(message, 0)
	end
	-- A file changed on disk since it was loaded is reloaded now, as entering it would: the place
	-- is found in what will be shown.
	if not done and vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) ~= "" then
		kit.guarded(buf, function()
			vim.cmd(("checktime %d"):format(buf))
		end)
	end
	-- Where the place is in the buffer as it is now: its line, last line and column; or nil and why.
	local function locate()
		local line, last, col = spec.line, spec.endLine or spec.line, spec.col
		if spec.match then
			local found, err = find(buf, spec.match, spec.line or 1)
			if not found then
				return nil, err or ("not found in %s: %s"):format(name, spec.match)
			end
			line, last, col = unpack(found)
		end
		local count = vim.api.nvim_buf_line_count(buf)
		if last > count then
			return nil, ("line %d is past the end of %s, at %d"):format(last, name, count)
		end
		return line, last, col
	end
	local line, last, col = locate()
	if not line then
		fail(last)
	end
	local tick = vim.api.nvim_buf_get_changedtick(buf)

	local win, opened = window(buf), false
	-- Where the user was goes in the window's jumplist, so <C-o> takes them back; unless asked
	-- not to, as by one following Pi around.
	local quiet = spec.jump == false
	local function jump()
		if not quiet then
			vim.api.nvim_win_call(win, function()
				vim.cmd("normal! m'")
			end)
		end
	end
	if win and vim.api.nvim_win_get_buf(win) ~= buf then
		jump()
		-- Unsaved changes there with 'hidden' off, or 'winfixbuf': rather than lose them, a split.
		-- An error from the user's autocommands once it shows the file is no failure.
		if not pcall(enter, win, buf, quiet) and vim.api.nvim_win_get_buf(win) ~= buf then
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
	elseif vim.api.nvim_win_get_cursor(win)[1] ~= line then
		jump()
	end
	-- The user's autocommands, as it was entered or focused, may have put another buffer in the
	-- window: it is entered once more, then refused rather than fought over. Or they may have
	-- changed this one: then the place is found again, in what is shown.
	local function settle()
		if vim.api.nvim_win_get_buf(win) ~= buf then
			pcall(enter, win, buf, quiet)
			if vim.api.nvim_win_get_buf(win) ~= buf then
				error(("autocommands showed another buffer in window %d instead of %s"):format(win, name), 0)
			end
		end
		-- Or made it a buffer of another kind: a path's must stay a file's, and none a terminal.
		local kind = vim.bo[buf].buftype
		if (spec.path and kind ~= "") or kind == "terminal" then
			error(spec.path and ("not a file: %s"):format(name) or ("%s is a terminal"):format(name), 0)
		end
		if vim.api.nvim_buf_get_changedtick(buf) ~= tick then
			line, last, col = locate()
			if not line then
				error(last, 0)
			end
			tick = vim.api.nvim_buf_get_changedtick(buf)
		end
	end
	settle()
	-- Focus stays where it is, unless asked to follow, as when the user asked to go there; then
	-- before the cursor is placed, so what focusing sets off is settled first.
	if spec.focus then
		vim.api.nvim_set_current_win(win)
		settle()
	end
	-- A file shown is listed, as the user's own would be; a buffer given is left as it was.
	if spec.path then
		vim.bo[buf].buflisted = true
	end

	local shown = vim.api.nvim_win_call(win, function()
		local before = vim.fn.winsaveview()
		vim.cmd(("silent! %d,%dfoldopen!"):format(line, last))
		-- On screen already, it is left where it is: the user knows where to look.
		local top, bottom = vim.fn.line("w0"), vim.fn.line("w$")
		local visible = top <= line and last <= bottom
		-- As `^` would: the first non-blank, or the last character of a line of blanks.
		local text = vim.api.nvim_buf_get_lines(buf, line - 1, line, true)[1]
		local at = math.max(math.min(col or (text:find("%S") or #text) - 1, #text - 1), 0)
		if at > 0 then
			at = at + vim.str_utf_start(text, at + 1) -- A character's first byte.
		end
		vim.api.nvim_win_set_cursor(win, { line, at })
		if not visible then
			reveal(win, line, last, spec.context or 3, spec.scroll or "center", last > bottom)
		end
		local after = vim.fn.winsaveview()
		return {
			shown = true,
			win = win,
			buf = buf,
			opened = opened,
			scrolled = after.topline ~= before.topline or after.skipcol ~= before.skipcol or after.leftcol ~= before.leftcol,
		}
	end)
	return shown
end
