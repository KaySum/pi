-- Installs `remote.nvim_follow.show`, once for each attachment: sent with every change, this
-- would be sent and compiled each time. It runs through nvim-remote, with `remote` in scope.
--
-- show(path, ranges, ms, group, cursor, reread, deletions) shows `path` in the editor at `ranges`
-- ({ first, last } lines), highlighted in `group` for `ms`, with the cursor at `cursor`
-- ({ line, byte column }) or else the first range's start. `reread` is for a file that
-- changed: a buffer already loaded is read again. Returns what happened, so a file left
-- alone can be told from one shown.

-- Place the viewport in screen rows, so deleted virtual lines and wrapped/folded text
-- contribute to its height. Changed intervals are scored by how much fits, not by the
-- distance between hunks. Ties favor centering, then the earlier change.
local function frame(win, count, ranges, deletions, cursor)
	local height = vim.api.nvim_win_get_height(win)
	local total = vim.api.nvim_win_text_height(win, {}).all
	local cache = {}
	local function edge(line, text)
		local key = line * 2 + (text and 1 or 0)
		if cache[key] == nil then
			local opts = { end_row = line - 1 }
			if text then
				opts.end_vcol = 0
			end
			cache[key] = vim.api.nvim_win_text_height(win, opts).all
		end
		return cache[key]
	end
	local function clamp(line)
		return math.max(1, math.min(line, count))
	end
	local function locate(row)
		local lo, hi = 1, count
		while lo < hi do
			local mid = math.floor((lo + hi) / 2)
			if edge(mid, false) > row then
				hi = mid
			else
				lo = mid + 1
			end
		end
		return lo
	end
	local spans, anchors = {}, {}
	for _, range in ipairs(ranges) do
		local first, last = clamp(range[1]), clamp(range[2])
		table.insert(spans, { edge(first, true), edge(last, false) })
		table.insert(anchors, first)
		table.insert(anchors, last)
	end
	-- Several removed blocks can share a boundary. Their virtual lines form one interval.
	local removed = {}
	for _, deletion in ipairs(deletions or {}) do
		removed[deletion.line] = (removed[deletion.line] or 0) + #deletion.lines
	end
	for line, size in pairs(removed) do
		local after = line > count and total or edge(clamp(line), true)
		table.insert(spans, { after - size, after })
		table.insert(anchors, clamp(line))
	end
	if #spans == 0 then
		return
	end
	table.sort(spans, function(a, b)
		return a[1] < b[1]
	end)
	local merged = {}
	for _, span in ipairs(spans) do
		local last = merged[#merged]
		if last and span[1] <= last[2] then
			last[2] = math.max(last[2], span[2])
		else
			table.insert(merged, { span[1], span[2] })
		end
	end
	local scrolloff = vim.wo[win].scrolloff
	if scrolloff < 0 then
		scrolloff = vim.o.scrolloff
	end
	scrolloff = math.min(scrolloff, math.floor((height - 1) / 2))
	local candidates = {}
	local function candidate(top)
		top = math.max(0, math.floor(top))
		local line = locate(top)
		-- Start at a buffer row or within its virtual filler. Partial wrapped rows are a
		-- best-effort case: don't change smoothscroll or the user's horizontal position.
		top = math.min(top, edge(line, true))
		candidates[top] = true
	end
	local first, last = merged[1][1], merged[#merged][2]
	candidate((first + last - height) / 2)
	for _, span in ipairs(merged) do
		candidate(span[1])
		candidate(span[2] - height)
		candidate((span[1] + span[2] - height) / 2)
	end
	table.insert(anchors, clamp(cursor[1]))
	for _, line in ipairs(anchors) do
		local row = edge(line, true)
		candidate(row - scrolloff)
		candidate(row - height + 1 + scrolloff)
		candidate(row - math.floor(height / 2))
	end
	local function visible(line, top)
		local row = edge(line, true)
		return row >= top + math.min(scrolloff, row)
			and row < top + height - math.min(scrolloff, math.max(0, total - row - 1))
	end
	local function at(top)
		if visible(clamp(cursor[1]), top) then
			return clamp(cursor[1]), cursor[2]
		end
		-- If the best view is around a later hunk, move the cursor there too. A cursor
		-- left on the first hunk would cause Neovim to scroll our chosen view away.
		for _, range in ipairs(ranges) do
			local line = clamp(math.max(range[1], math.min(range[2], locate(top + height / 2))))
			if visible(line, top) then
				return line, 0
			end
		end
		for _, line in ipairs(anchors) do
			if visible(line, top) then
				return line, 0
			end
		end
	end
	local changed = 0
	for _, span in ipairs(merged) do
		changed = changed + span[2] - span[1]
	end
	local best
	for top in pairs(candidates) do
		local line, column = at(top)
		if line then
			local score, distance = 0, math.huge
			for _, span in ipairs(merged) do
				score = score + math.max(0, math.min(top + height, span[2]) - math.max(top, span[1]))
				distance = math.min(distance, math.abs(top + height / 2 - (span[1] + span[2]) / 2))
			end
			if score == changed then
				distance = math.abs(top + height / 2 - (first + last) / 2)
			end
			if
				not best
				or score > best.score
				or (
					score == best.score
					and (distance < best.distance or (distance == best.distance and top < best.top))
				)
			then
				best = { top = top, score = score, distance = distance, line = line, column = column }
			end
		end
	end
	if not best then
		return
	end
	local top = locate(best.top)
	local text = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), best.line - 1, best.line, true)[1]
	vim.api.nvim_win_set_cursor(win, { best.line, math.max(0, math.min(best.column, #text - 1)) })
	vim.fn.winrestview({ topline = top, topfill = math.max(0, edge(top, true) - best.top), skipcol = 0 })
end

-- This attachment's own highlights, apart from what other features put in remote.ns, and
-- gone with it.
local state = remote.nvim_follow
if not state then
	state = { ns = vim.api.nvim_create_namespace("nvim-follow." .. remote.channel), shown = {} }
	remote.nvim_follow = state
	remote.on_detach(function()
		for _, b in ipairs(vim.api.nvim_list_bufs()) do
			vim.api.nvim_buf_clear_namespace(b, state.ns, 0, -1)
		end
	end)
end

function state.show(path, ranges, ms, group, cursor, reread, deletions)
	if not vim.uv.fs_stat(path) then
		return "missing"
	end

	-- The buffer holding the file: by its name, which it nearly always has, else by where its
	-- name really leads (a symlink, say). Where a name leads is asked once for each.
	local function find(matches)
		return vim.iter(vim.api.nvim_list_bufs()):find(function(b)
			local name = vim.api.nvim_buf_get_name(b)
			return name ~= "" and matches(name)
		end)
	end
	local buf = find(function(name)
		return name == path
	end)
	if not buf then
		state.real = state.real or {}
		local function real(name)
			if state.real[name] == nil then
				state.real[name] = vim.uv.fs_realpath(name) or name
			end
			return state.real[name]
		end
		local target = vim.uv.fs_realpath(path) or path
		buf = find(function(name)
			return real(name) == target
		end)
	end
	-- Reloading would throw away the user's unsaved work.
	if buf and vim.bo[buf].modified then
		return "modified"
	end

	-- The window the user is in is theirs while they type: it is used only in normal mode, and
	-- only when there is no other. Otherwise: one showing the file, the one they came from, any.
	local current = vim.api.nvim_get_current_win()
	local typing = vim.api.nvim_get_mode().mode ~= "n"
	local function usable(win)
		if vim.bo[vim.api.nvim_win_get_buf(win)].buftype ~= "" then
			return false
		end
		if vim.api.nvim_win_get_config(win).relative ~= "" then
			return false
		end
		return win ~= current or not typing
	end
	local wins = vim.tbl_filter(usable, vim.api.nvim_tabpage_list_wins(0))
	local others = vim.tbl_filter(function(w)
		return w ~= current
	end, wins)
	local previous = vim.fn.win_getid(vim.fn.winnr("#"))
	local win = vim.iter(wins):find(function(w)
		return w ~= current and vim.api.nvim_win_get_buf(w) == buf
	end) or (vim.tbl_contains(others, previous) and previous) or others[1] or (vim.tbl_contains(wins, current) and current)
	if not win then
		return "no window"
	end

	-- keepjumps and keepalt: <C-o> and <C-^> stay the user's, not a trail of Pi's files. Each
	-- read from disk runs filetype detection, parsing and the language servers again, so a file
	-- is read once at most: when it is opened, or when one already loaded has changed.
	local loaded = buf ~= nil and vim.api.nvim_buf_is_loaded(buf)
	local ok, err = pcall(vim.api.nvim_win_call, win, function()
		if not buf then
			return vim.cmd("keepjumps keepalt edit " .. vim.fn.fnameescape(path))
		end
		if vim.api.nvim_win_get_buf(win) ~= buf then
			vim.cmd("keepjumps keepalt buffer " .. buf)
		end
		if loaded and reread then
			vim.cmd("keepjumps keepalt edit")
		end
	end)
	if not ok then
		return err
	end

	buf = vim.api.nvim_win_get_buf(win)
	vim.api.nvim_set_hl(0, "PiFollow", { link = "DiffAdd", default = true })
	vim.api.nvim_set_hl(0, "PiFollowRead", { link = "Visual", default = true })
	vim.api.nvim_set_hl(0, "PiFollowDelete", { link = "DiffDelete", default = true })
	vim.api.nvim_buf_clear_namespace(buf, state.ns, 0, -1)
	local count = vim.api.nvim_buf_line_count(buf)
	for _, range in ipairs(ranges) do
		vim.api.nvim_buf_set_extmark(
			buf,
			state.ns,
			math.min(range[1], count) - 1,
			0,
			{ end_row = math.min(range[2], count), hl_group = group or "PiFollow", hl_eol = true, strict = false }
		)
	end
	-- Deleted text lives between real lines, never highlighting the unchanged survivor. At EOF
	-- it goes below the last line; even an emptied file has Neovim's single empty buffer line.
	if deletions == vim.NIL then
		deletions = nil
	end
	for _, deletion in ipairs(deletions or {}) do
		local virtual = {}
		for _, text in ipairs(deletion.lines) do
			table.insert(virtual, { { text, "PiFollowDelete" } })
		end
		local above = deletion.line <= count
		vim.api.nvim_buf_set_extmark(
			buf,
			state.ns,
			math.max(0, math.min(deletion.line, count) - 1),
			0,
			{ virt_lines = virtual, virt_lines_above = above, strict = false }
		)
	end
	-- Only the latest change to a buffer clears it, so a quick second change keeps its highlight;
	-- counted by buffer, so a change to another file does not stop this one clearing.
	state.shown[buf] = (state.shown[buf] or 0) + 1
	local shown = state.shown[buf]
	vim.defer_fn(function()
		if state.shown[buf] == shown and vim.api.nvim_buf_is_valid(buf) then
			vim.api.nvim_buf_clear_namespace(buf, state.ns, 0, -1)
		end
	end, ms)

	if cursor == vim.NIL then
		cursor = nil
	end
	cursor = cursor or (ranges[1] and { ranges[1][1], 0 })
	if cursor then
		local line = math.max(1, math.min(cursor[1], count))
		local text = vim.api.nvim_buf_get_lines(buf, line - 1, line, true)[1]
		-- In normal mode the cursor sits on a character, so the last one is as far as it goes.
		vim.api.nvim_win_set_cursor(win, { line, math.max(0, math.min(cursor[2], #text - 1)) })
		vim.api.nvim_win_call(win, function()
			frame(win, count, ranges, deletions, cursor)
		end)
	end
	return "shown"
end
