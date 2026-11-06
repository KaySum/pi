-- Installs `remote.nvim_point`, once for each attachment: it shows the user a place in a file, in
-- their window (never Pi's terminal), its cursor there, leaving focus where it is unless asked. It runs
-- through nvim-remote, with `remote` in scope.

if remote.nvim_point then
	return
end
local point = {}
remote.nvim_point = point

-- Load `buf`, as the user's own would be; `existed`: it was in the buffer list before. What was
-- done for it, to undo if it is not shown after all: "added", "loaded", or nothing.
local function load(buf, existed)
	if vim.api.nvim_buf_is_loaded(buf) then
		return nil
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
	return existed and "loaded" or "added"
end

-- The buffer of `spec`: `spec.buf`, any but a terminal, or the file at `spec.path`. Loaded,
-- and what was done for it (see `load`).
local function buffer(spec)
	if spec.buf then
		if not vim.api.nvim_buf_is_valid(spec.buf) then
			error(("no buffer %d"):format(spec.buf), 0)
		elseif vim.bo[spec.buf].buftype == "terminal" then
			error(("buffer %d is a terminal"):format(spec.buf), 0)
		end
		return spec.buf, load(spec.buf, true)
	end
	local path = spec.path
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
	local done = load(buf, existed)
	-- The user's autocommands, as it was read, may have made it a buffer of another kind.
	if vim.bo[buf].buftype ~= "" then
		if done then
			vim.api.nvim_buf_delete(buf, { force = true, unload = done == "loaded" })
		end
		error(("not a file: %s"):format(path), 0)
	end
	return buf, done
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
		local here = win ~= 0 and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_config(win).relative == ""
		if here and vim.api.nvim_win_get_buf(win) == buf then
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

-- Whether two names are one file, as Neovim tells files apart: by device and inode, so links,
-- hard or symbolic, are; by name for a file no longer on disk, case aside with 'fileignorecase'.
local function same_file(a, b)
	local x, y = vim.uv.fs_stat(a), vim.uv.fs_stat(b)
	if x and y then
		return x.dev == y.dev and x.ino == y.ino
	end
	a, b = vim.fs.normalize(a), vim.fs.normalize(b)
	if vim.o.fileignorecase then
		a, b = vim.fn.tolower(a), vim.fn.tolower(b)
	end
	return a == b
end

-- Whether a window of this tab shows `spec.buf`, or the file at `spec.path`.
local function open_here(spec)
	for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
		local buf = vim.api.nvim_win_get_buf(win)
		local name = vim.api.nvim_buf_get_name(buf)
		if vim.api.nvim_win_get_config(win).relative == "" then
			if spec.buf == buf or (spec.path and name ~= "" and same_file(spec.path, name)) then
				return true
			end
		end
	end
	return false
end

-- Warn with the first of `texts` that fits where messages go (`v:echospace`, less with 'ruler'
-- and 'showcmd'), else the last cut to fit: a longer one would stop the editor at "Press ENTER".
local function warn(texts)
	local room = vim.v.echospace
	local text = vim.iter(texts):find(function(text)
		return vim.fn.strdisplaywidth(text) <= room
	end)
	if not text then
		text = ""
		for _, char in ipairs(vim.fn.split(texts[#texts], "\\zs")) do
			if vim.fn.strdisplaywidth(text .. char) > room - 1 then
				break
			end
			text = text .. char
		end
		text = room > 1 and text .. "…" or nil
	end
	if text then
		vim.notify(text, vim.log.levels.WARN)
	end
end

-- Whether a FileChangedShell autocommand of the user's applies to `buf`: one of its own, or one
-- whose pattern Neovim matches to its file. Neovim's own matching decides (short and full
-- names, 'fileignorecase'): each pattern is given to a probe of ours, fired for `buf` alone.
local function handled(buf)
	local applies = false
	local probe = vim.api.nvim_create_augroup("nvim-point-probe", { clear = true })
	for _, autocmd in ipairs(vim.api.nvim_get_autocmds({ event = "FileChangedShell" })) do
		if autocmd.buflocal then
			applies = applies or autocmd.buffer == buf
		else
			vim.api.nvim_create_autocmd("FileChangedShell", {
				group = probe,
				pattern = autocmd.pattern,
				callback = function()
					applies = true
				end,
			})
		end
	end
	if not applies then
		pcall(vim.api.nvim_exec_autocmds, "FileChangedShell", { group = probe, buffer = buf, modeline = false })
	end
	vim.api.nvim_del_augroup_by_id(probe)
	return applies
end

-- Run `fn` where Neovim may find `buf`'s file changed on disk and ask what to do at a prompt,
-- which would hold this call until the user answers: unless they handle it themselves (a
-- FileChangedShell that applies to it), it is reloaded as 'autoread' would, else left, and they
-- are told after.
local function guarded(buf, fn)
	local guard = not handled(buf)
		and vim.api.nvim_create_autocmd("FileChangedShell", {
			buffer = buf,
			callback = function()
				local reason = vim.v.fcs_reason
				vim.v.fcs_choice = reason == "changed" and vim.o.autoread and "reload" or ""
				if vim.v.fcs_choice == "" then
					-- As Neovim shows what is not printable (^@ for a newline, ^I): a newline would start a line.
					local name = vim.fn.strtrans(vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":t"))
					local how = reason == "conflict" and " and here" or (" (%s)"):format(reason)
					vim.schedule(function()
						warn({ ("%s changed on disk%s: :e! loads it"):format(name, how), ("%s changed on disk%s"):format(name, how) })
					end)
				end
			end,
		})
	local ok, err = pcall(fn)
	if guard then
		vim.api.nvim_del_autocmd(guard)
	end
	if not ok then
		error(err, 0)
	end
end

-- Show `buf` in `win`; with `quiet`, leaving its jumplist and alternate file as they were.
local function enter(win, buf, quiet)
	guarded(buf, function()
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
	local mode = vim.api.nvim_get_mode().mode
	if not (mode == "n" or mode == "nt" or mode == "t") then
		return { shown = false, busy = mode }
	elseif vim.fn.getcmdwintype() ~= "" then
		return { shown = false, busy = "cmdwin" } -- In q:, no other window can change.
	elseif spec.open == false and not open_here(spec) then
		return { shown = false, closed = true } -- Neither loaded nor any window changed for it.
	end
	local buf, done = buffer(spec)
	local name = spec.path or ("buffer %d"):format(buf)
	-- Not left loaded (a swap file and all) for a file the user did not open.
	local function fail(message)
		if done then
			vim.api.nvim_buf_delete(buf, { force = true, unload = done == "loaded" })
		end
		error(message, 0)
	end
	-- A file changed on disk since it was loaded is reloaded now, as entering it would: the place
	-- is found in what will be shown.
	if not done and vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) ~= "" then
		guarded(buf, function()
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
