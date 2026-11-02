-- Installs `remote.nvim_point`, once for each attachment: it shows the user a place in a file, in
-- their window (never Pi's terminal), its cursor there, leaving focus where it is. It runs
-- through nvim-remote, with `remote` in scope.

if remote.nvim_point then
	return
end
local point = {}
remote.nvim_point = point

-- The buffer of the file at `path`: loaded, as the user's own would be. And what was done for
-- it, to undo if it is not shown after all: "added", "loaded", or nothing.
local function buffer(path)
	local stat = vim.uv.fs_stat(path)
	local existed = vim.fn.bufexists(path) == 1
	if not existed and not stat then
		error(("no such file: %s"):format(path), 0)
	elseif stat and stat.type ~= "file" then
		error(("not a file: %s"):format(path), 0)
	elseif stat and not vim.uv.fs_access(path, "R") then
		error(("cannot read: %s"):format(path), 0)
	end
	local buf = vim.fn.bufadd(path)
	if vim.bo[buf].buftype ~= "" then
		error(("not a file: %s"):format(path), 0)
	end
	if vim.api.nvim_buf_is_loaded(buf) then
		return buf
	end
	-- An existing swap file would otherwise stop the editor at a prompt.
	local shortmess = vim.o.shortmess
	vim.opt.shortmess:append("A")
	local ok, err = pcall(vim.fn.bufload, buf)
	vim.o.shortmess = shortmess
	-- An error from the user's autocommands once it is loaded is no failure.
	if not ok and not vim.api.nvim_buf_is_loaded(buf) then
		error(err, 0)
	end
	return buf, existed and "loaded" or "added"
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

-- Show `buf` in `win`; with `quiet`, leaving its jumplist and alternate file as they were.
-- Entering a buffer whose file changed on disk, Neovim asks what to do at a
-- prompt, which would hold this call until the user answers: unless they handle it themselves
-- (FileChangedShell), it is reloaded as 'autoread' would, else left, and they are told after.
local function enter(win, buf, quiet)
	local guard = #vim.api.nvim_get_autocmds({ event = "FileChangedShell" }) == 0
		and vim.api.nvim_create_autocmd("FileChangedShell", {
			buffer = buf,
			callback = function()
				local reason = vim.v.fcs_reason
				vim.v.fcs_choice = reason == "changed" and vim.o.autoread and "reload" or ""
				if vim.v.fcs_choice == "" then
					-- One line, which a longer message would not be, stopping at "Press ENTER".
					local name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":t")
					local how = reason == "conflict" and " and here" or (" (%s)"):format(reason)
					vim.schedule(function()
						vim.notify(("%s changed on disk%s: :e! loads it"):format(name, how), vim.log.levels.WARN)
					end)
				end
			end,
		})
	local ok, err = pcall(function()
		if not quiet then
			return vim.api.nvim_win_set_buf(win, buf)
		end
		vim.api.nvim_win_call(win, function()
			vim.cmd(("keepalt keepjumps buffer %d"):format(buf))
		end)
	end)
	if guard then
		vim.api.nvim_del_autocmd(guard)
	end
	if not ok then
		error(err, 0)
	end
end

--- Show `spec.path` at `spec.line` (to `spec.endLine`), the cursor at `spec.col` (0-based bytes;
--- else the line's first non-blank); or where `spec.match` is, nearest `spec.line`. Not while
--- the user is busy: then `{ shown = false, busy = mode }`. (At a prompt this does not run:
--- nvim-remote fails the call first.)
function point.show(spec)
	local mode = vim.api.nvim_get_mode().mode
	if not (mode == "n" or mode == "nt" or mode == "t") then
		return { shown = false, busy = mode }
	elseif vim.fn.getcmdwintype() ~= "" then
		return { shown = false, busy = "cmdwin" } -- In q:, no other window can change.
	end
	local buf, done = buffer(spec.path)
	-- Not left loaded (a swap file and all) for a file the user did not open.
	local function fail(message)
		if done then
			vim.api.nvim_buf_delete(buf, { force = true, unload = done == "loaded" })
		end
		error(message, 0)
	end
	local line, last, col = spec.line, spec.endLine or spec.line, spec.col
	if spec.match then
		local found, err = find(buf, spec.match, spec.line or 1)
		if not found then
			fail(err or ("not found in %s: %s"):format(spec.path, spec.match))
		end
		line, last, col = unpack(found)
	end
	local count = vim.api.nvim_buf_line_count(buf)
	if last > count then
		fail(("line %d is past the end of %s, at %d"):format(last, spec.path, count))
	end

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
	vim.bo[buf].buflisted = true

	return vim.api.nvim_win_call(win, function()
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
			scrolled = after.topline ~= before.topline or after.skipcol ~= before.skipcol,
		}
	end)
end
