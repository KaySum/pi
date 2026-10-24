-- Installs `remote.nvim_virtual_text`, once for each attachment: api.ts calls into it by name
-- afterwards. It runs through nvim-remote, with `remote` in scope. Each group (one for each
-- extension using it, say) has its own namespace; every mark placed has an id of its own, and
-- all of them go when Pi detaches.

local POSITIONS = { eol = "eol", right = "right_align", overlay = "overlay", inline = "inline" }
local DEFAULTS = {
	PiVirtualText = "Comment",
	PiVirtualTextInfo = "DiagnosticVirtualTextInfo",
	PiVirtualTextHint = "DiagnosticVirtualTextHint",
	PiVirtualTextWarn = "DiagnosticVirtualTextWarn",
	PiVirtualTextError = "DiagnosticVirtualTextError",
	PiVirtualTextOk = "DiagnosticVirtualTextOk",
}

local state = remote.nvim_virtual_text
if not state then
	-- `marks[id]` is { group, spec, ns, extmarks, anchor, generation, stale }: `spec` is the mark as
	-- given, its file resolved to `buf`; `extmarks` by part (`span`, `sign`, `text`), the span
	-- covering its lines and moving with them; and
	-- `anchor` is the text it was placed on, found again when the file is reloaded. `stale`:
	-- changed while hidden by a deletion, drawn as it was.
	-- `styles` are the groups made from style tables; `watched`, the buffers whose changes
	-- are followed, and `queued` those with a sync to come.
	state = { namespaces = {}, marks = {}, styles = {}, next = 0, watched = {}, queued = {} }
	remote.nvim_virtual_text = state
	remote.on_detach(function()
		state.closed = true
		for _, ns in pairs(state.namespaces) do
			for _, buf in ipairs(vim.api.nvim_list_bufs()) do
				vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
			end
		end
	end)
	-- A colorscheme clears every highlight group, ours as well.
	vim.api.nvim_create_autocmd("ColorScheme", {
		group = remote.group,
		callback = function()
			state.define()
		end,
	})
	vim.api.nvim_create_autocmd("BufWipeout", {
		group = remote.group,
		callback = function(ev)
			for id, mark in pairs(state.marks) do
				if mark.spec.buf == ev.buf then
					state.marks[id] = nil
				end
			end
		end,
	})
	-- Reloaded from disk, a buffer keeps its marks at the same line numbers, wherever its
	-- text went; each is moved back onto its own. Edits within the buffer move them anyway.
	vim.api.nvim_create_autocmd("BufReadPost", {
		group = remote.group,
		callback = function(ev)
			state.reanchor(ev.buf)
		end,
	})
	-- Filled lines are padded to the editor's width, which has changed.
	vim.api.nvim_create_autocmd("VimResized", {
		group = remote.group,
		callback = function()
			state.refill()
		end,
	})
end

function state.define()
	for name, link in pairs(DEFAULTS) do
		vim.api.nvim_set_hl(0, name, { link = link, default = true })
	end
	for name, style in pairs(state.styles) do
		vim.api.nvim_set_hl(0, name, style)
	end
end
state.define()

local function namespace(group)
	state.namespaces[group] = state.namespaces[group]
		or vim.api.nvim_create_namespace(("nvim-virtual-text.%d.%s"):format(remote.channel, group))
	return state.namespaces[group]
end

-- A group's name, or a style table (as nvim_set_hl takes) made into a group named after it.
local function highlight(hl)
	if type(hl) ~= "table" then
		return hl ~= vim.NIL and hl or nil
	end
	local name = "PiVirtualText_" .. vim.fn.sha256(vim.inspect(hl)):sub(1, 8)
	if not state.styles[name] then
		vim.api.nvim_set_hl(0, name, hl)
		state.styles[name] = hl
	end
	return name
end

local function find(path)
	for _, buf in ipairs(vim.api.nvim_list_bufs()) do
		if vim.api.nvim_buf_get_name(buf) == path then
			return buf
		end
	end
	return -1
end

-- The buffer of `spec.buf`, or of the file at `spec.path`: loaded but not listed if the user
-- has not opened it, so marks are there when they do.
local function buffer(spec)
	if spec.buf then
		return vim.api.nvim_buf_is_valid(spec.buf) and spec.buf or error(("no buffer %d"):format(spec.buf), 0)
	end
	if vim.fn.bufexists(spec.path) == 0 and not vim.uv.fs_stat(spec.path) then
		error(("no such file: %s"):format(spec.path), 0)
	end
	local buf = vim.fn.bufadd(spec.path)
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

-- Columns of text in the widest window showing `buf`, else in the editor.
local function text_width(buf)
	local width = 0
	for _, win in ipairs(vim.fn.win_findbuf(buf)) do
		width = math.max(width, vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff)
	end
	return width > 0 and width or vim.o.columns
end

-- Measured in sequence: a tab's width depends on the column it starts at.
local function width_of(chunks)
	local width = 0
	for _, chunk in ipairs(chunks) do
		width = width + vim.fn.strdisplaywidth(chunk[1], width)
	end
	return width
end

-- `text` (a string or chunks) as lines of chunks, split at its newlines, in highlights.
local function lines_of(text, default)
	if type(text) == "string" then
		text = { { text } }
	end
	local lines = { {} }
	for _, chunk in ipairs(text) do
		local hl = highlight(chunk[2]) or default
		for i, piece in ipairs(vim.split(chunk[1], "\n", { plain = true })) do
			if i > 1 then
				table.insert(lines, {})
			end
			if piece ~= "" then
				table.insert(lines[#lines], { piece, hl })
			end
		end
	end
	return lines
end

-- Break a line of chunks at spaces so that none ends past column `limit`, where it can be,
-- the line starting at column `start`. A word is whole across chunks: a change of highlight
-- is no place to break. Widths are measured where the text falls, for tabs.
local function wrap(chunks, limit, start)
	local words = {}
	for _, chunk in ipairs(chunks) do
		local text, at = chunk[1], 1
		while at <= #text do
			local first, last = text:find("^%s+", at)
			local space = first ~= nil
			if not space then
				first, last = text:find("^%S+", at)
			end
			local word = words[#words]
			if not word or (word.spaced and not space) then
				word = { pieces = {}, spaced = false }
				table.insert(words, word)
			end
			table.insert(word.pieces, { text:sub(first, last), chunk[2], space = space })
			word.spaced = word.spaced or space
			at = last + 1
		end
	end
	local function after(pieces, col, spaces)
		for _, piece in ipairs(pieces) do
			if spaces or not piece.space then
				col = col + vim.fn.strdisplaywidth(piece[1], col)
			end
		end
		return col
	end
	local lines, col = { {} }, start
	for _, word in ipairs(words) do
		local ends = after(word.pieces, col, false)
		if col > start and ends > col and ends > limit then
			table.insert(lines, {})
			col = start
		end
		local line = lines[#lines]
		for _, piece in ipairs(word.pieces) do
			local last = line[#line]
			if last and last[2] == piece[2] then
				last[1] = last[1] .. piece[1]
			else
				table.insert(line, { piece[1], piece[2] })
			end
		end
		col = after(word.pieces, col, true)
	end
	return lines
end

local function virtual_lines(buf, spec, row)
	local default = highlight(spec.hl) or "PiVirtualText"
	local lines = lines_of(spec.text, default)
	local indent = 0
	if spec.indent == true then
		indent = vim.fn.strdisplaywidth(vim.api.nvim_buf_get_lines(buf, row, row + 1, true)[1]:match("^%s*"))
	elseif type(spec.indent) == "number" then
		indent = spec.indent
	end
	if spec.wrap then
		local wrapped = {}
		local limit = math.max(indent + 1, spec.wrap == true and text_width(buf) or spec.wrap)
		for _, line in ipairs(lines) do
			vim.list_extend(wrapped, wrap(line, limit, indent))
		end
		lines = wrapped
	end
	-- Filled, a line's background is `hl`'s from edge to edge: indentation, blank lines and all.
	local background = spec.fill and default or nil
	return vim.tbl_map(function(line)
		if indent > 0 then
			table.insert(line, 1, { string.rep(" ", indent), background })
		end
		-- Virtual lines take no hl_eol. Padded to the editor's width, which is cut to the
		-- window's, the background fills any window showing them, however it is resized.
		if spec.fill then
			table.insert(line, { string.rep(" ", math.max(0, vim.o.columns - width_of(line))), background })
		end
		return line
	end, lines)
end

-- What `match` looks for: its lines, without the space around them, each found within a line.
local function needles_of(match)
	local needles = vim.tbl_map(vim.trim, vim.split(match, "\n", { plain = true }))
	while needles[#needles] == "" do
		table.remove(needles)
	end
	while needles[1] == "" do
		table.remove(needles, 1)
	end
	return #needles > 0 and needles or error("match is only space", 0)
end

-- The text of each buffer, as `text_of` last read it, while anything still holds it.
local texts = setmetatable({}, { __mode = "v" })

-- The text of `buf`, read once to find marks' text in, until it changes: a reload looks for
-- every mark's, and a call may place many. `lines` are trimmed when first looked at;
-- `joined` (see below) is them all, untrimmed, one string, in which `find` searches in C,
-- and `starts` where each begins in it.
local function text_of(buf)
	local tick = vim.api.nvim_buf_get_changedtick(buf)
	if texts[buf] and texts[buf].tick == tick then
		return texts[buf]
	end
	local raw = vim.api.nvim_buf_get_lines(buf, 0, -1, true)
	local text = { tick = tick, n = #raw, raw = raw }
	texts[buf] = text
	text.lines = setmetatable({}, {
		__index = function(cache, i)
			local line = raw[i] and vim.trim(raw[i])
			rawset(cache, i, line)
			return line
		end,
	})
	return text
end

-- `text` with `joined` and `starts`, made only once a search needs them: most marks are where
-- they were.
local function joined(text)
	if not text.joined then
		text.joined, text.starts = table.concat(text.raw, "\n"), {}
		local at = 1
		for i, line in ipairs(text.raw) do
			text.starts[i] = at
			at = at + #line + 1
		end
		text.starts[text.n + 1] = at -- Where a line after the last would start.
	end
	return text
end

local function holds(lines, needles, line)
	for i, needle in ipairs(needles) do
		local text = lines[line + i - 1]
		if not (text and text:find(needle, 1, true)) then
			return false
		end
	end
	return true
end

-- The line, from `from` on, that byte `at` of `joined` is on.
local function line_of(text, at, from)
	local lo, hi = from, text.n
	while lo < hi do
		local mid = math.floor((lo + hi + 1) / 2)
		if text.starts[mid] <= at then
			lo = mid
		else
			hi = mid - 1
		end
	end
	return lo
end

-- The lines from `first` to `last` holding `needle`, in order: those lines alone searched, in
-- C. A needle has neither newlines nor space at its ends: it is in a trimmed line just when
-- in the line.
local function occurrences(text, needle, first, last)
	joined(text)
	local found, from = {}, text.starts[first]
	local window, at = text.joined:sub(from, text.starts[last + 1] - 2), 1
	while true do
		local hit = window:find(needle, at, true)
		if not hit then
			return found
		end
		local line = line_of(text, from + hit - 1, first)
		table.insert(found, line)
		at = text.starts[line + 1] - from + 1
	end
end

-- The lines that are, trimmed, just `needle`, in order, from one index of the whole text.
local function lines_equal(text, needle)
	if not text.exact then
		text.exact = {}
		for i = 1, text.n do
			local line = text.lines[i]
			text.exact[line] = text.exact[line] or {}
			table.insert(text.exact[line], i)
		end
	end
	return text.exact[needle] or {}
end

-- The longest of `needles`, and where it is among them: where it is found, the rest may be.
local function longest(needles)
	local key, offset = "", 0
	for i, needle in ipairs(needles) do
		if #needle > #key then
			key, offset = needle, i - 1
		end
	end
	return key, offset
end

-- Of the lines `up` and `down` give (nearest first, before and from where a start at `near`
-- would put them), less `offset`, the nearest `near` that `accept`s, earlier on a tie.
local function nearest(up, down, offset, near, accept)
	local before, after = up(), down()
	while before or after do
		local line
		if before and (not after or near - (before - offset) <= (after - offset) - near) then
			line, before = before - offset, up()
		else
			line, after = after - offset, down()
		end
		if line >= 1 and accept(line) then
			return line
		end
	end
end

-- The items of `list` (in order) at or after `line`, then those before it, nearest first.
local function around(list, line)
	local lo, hi = 1, #list + 1
	while lo < hi do
		local mid = math.floor((lo + hi) / 2)
		if list[mid] < line then
			lo = mid + 1
		else
			hi = mid
		end
	end
	local before, after = lo - 1, lo
	return function()
		before = before - 1
		return list[before + 1]
	end, function()
		after = after + 1
		return list[after - 1]
	end
end

-- The line nearest `near` where `needles` start, earlier on a tie: found where the longest of
-- them is, searching outward, so the further it moved the longer it takes, and text that is
-- gone takes one search of the whole text in C. `exact`: whole
-- lines, as a mark placed by line keeps, found anywhere just as they are before within
-- others. A needle only of space is found anywhere.
local function locate(text, needles, near, exact)
	near = math.max(1, math.min(near, text.n))
	local function within(line)
		return holds(text.lines, needles, line)
	end
	if within(near) then
		return near
	end
	local key, offset = longest(needles)
	if key == "" then
		local line = math.min(near, text.n - #needles + 1)
		return line >= 1 and line or nil
	end
	if exact then
		local up, down = around(lines_equal(text, key), near + offset)
		local line = nearest(up, down, offset, near, function(line)
			for i, needle in ipairs(needles) do
				if text.lines[line + i - 1] ~= needle then
					return false
				end
			end
			return true
		end)
		if line then
			return line
		end
	end
	-- In rings ever further out, both sides: what one holds is nearer than any beyond it.
	local base, inner, outer = near + offset, 0, 64
	while true do
		local best
		local function try(first, last)
			first, last = math.max(1, first), math.min(text.n, last)
			for _, found in ipairs(first <= last and occurrences(text, key, first, last) or {}) do
				local line = found - offset
				local distance = math.abs(line - near)
				if line >= 1 and within(line) and (not best or distance < math.abs(best - near)) then
					best = line
				end
			end
		end
		try(base - outer + 1, base - math.max(inner, 1))
		try(base + inner, base + outer - 1)
		if best or (base - outer + 1 <= 1 and base + outer - 1 >= text.n) then
			return best
		end
		inner, outer = outer, outer * 2
	end
end

local function delete(buf, ns, extmarks)
	for _, extmark in pairs(extmarks) do
		pcall(vim.api.nvim_buf_del_extmark, buf, ns, extmark)
	end
end

-- `reuse`: the extmarks to draw over, by part, keeping their ids.
local function render(buf, ns, spec, resolve, extmarks, reuse)
	local needles = spec.match and needles_of(spec.match)
	if needles and resolve then
		spec.line = locate(text_of(buf), needles, spec.line or 1)
			or error(("not found in %s: %s"):format(vim.api.nvim_buf_get_name(buf), spec.match), 0)
		spec.endLine = spec.line + #needles - 1
	end
	local count = vim.api.nvim_buf_line_count(buf)
	local function row(line)
		return math.max(1, math.min(line, count)) - 1
	end
	local first, last = row(spec.line), row(spec.endLine or spec.line)
	local base = { priority = spec.priority, invalidate = spec.invalidate, strict = false }
	local function put(part, line, col, opts)
		opts = vim.tbl_extend("force", base, opts, { id = reuse[part] })
		extmarks[part] = vim.api.nvim_buf_set_extmark(buf, ns, line, col, opts)
	end

	-- First, as `current` reads it: whole lines unless columns are given, then characters.
	local span = { hl_group = highlight(spec.highlight) }
	local col = 0
	if spec.col or spec.endCol then
		col = spec.col or 0
		span.end_row = last
		span.end_col = spec.endCol or #vim.api.nvim_buf_get_lines(buf, last, last + 1, true)[1]
	else
		span.end_row, span.end_col, span.hl_eol = last + 1, 0, spec.highlight ~= nil
	end
	put("span", first, col, span)

	-- On a span, a sign would show on every line of it.
	if spec.sign then
		local sign = type(spec.sign) == "string" and { spec.sign } or spec.sign
		put("sign", first, 0, {
			sign_text = sign[1],
			sign_hl_group = highlight(sign[2]) or highlight(spec.hl) or "PiVirtualText",
		})
	end

	if spec.text then
		local position = spec.position or "eol"
		local at, opts = position == "below" and last or first, nil
		if position == "above" or position == "below" then
			-- Measured as that buffer shows text: its 'tabstop', not the current buffer's.
			local lines = vim.api.nvim_buf_call(buf, function()
				return virtual_lines(buf, spec, at)
			end)
			opts = { virt_lines = lines, virt_lines_above = position == "above" }
		else
			local line = {}
			for i, chunks in ipairs(lines_of(spec.text, highlight(spec.hl) or "PiVirtualText")) do
				if i > 1 then
					table.insert(line, { " " })
				end
				vim.list_extend(line, chunks)
			end
			opts = { virt_text = line, hl_mode = "combine" }
			if type(position) == "number" then
				opts.virt_text_win_col = position
			else
				opts.virt_text_pos = POSITIONS[position]
			end
		end
		put("text", at, (position == "overlay" or position == "inline") and spec.col or 0, opts)
	end
	return needles or vim.tbl_map(vim.trim, vim.api.nvim_buf_get_lines(buf, first, last + 1, true))
end

-- Draw `spec`; returns its namespace, extmarks and anchor. `resolve`: find its `match`, and
-- fail if it is nowhere; otherwise it stays on its lines, whatever their text now. One that
-- fails leaves nothing drawn.
-- `old`: the mark this replaces, drawn over in its buffer, so that undo, which restores
-- extmarks by id, still knows them; its parts not drawn now go. One hidden by a deletion is
-- drawn anew: drawn over where it is, Neovim would keep it hidden.
local function draw(group, spec, resolve, old)
	local buf, ns = buffer(spec), namespace(group)
	spec.buf, spec.path = buf, nil
	local reuse = {}
	if old and old.spec.buf == buf and old.ns == ns then
		for part, extmark in pairs(old.extmarks) do
			local found = vim.api.nvim_buf_get_extmark_by_id(buf, ns, extmark, { details = true })
			if found[1] and not found[3].invalid then
				reuse[part] = extmark
			end
		end
	end
	local extmarks = {}
	local ok, anchor = pcall(render, buf, ns, spec, resolve, extmarks, reuse)
	if not ok then
		delete(buf, ns, vim.tbl_filter(function(extmark)
			return not vim.tbl_contains(vim.tbl_values(reuse), extmark)
		end, vim.tbl_values(extmarks)))
		error(anchor, 0)
	end
	if old then
		delete(old.spec.buf, old.ns, vim.tbl_filter(function(extmark)
			return not vim.tbl_contains(vim.tbl_values(extmarks), extmark)
		end, vim.tbl_values(old.extmarks)))
	end
	return ns, extmarks, anchor
end

local function erase(mark)
	delete(mark.spec.buf, mark.ns, mark.extmarks)
end

local function remove(id)
	local mark = state.marks[id]
	if not mark then
		return
	end
	state.marks[id] = nil
	erase(mark)
end

-- The mark's spec, its lines and columns where edits have moved them, and whether deleting
-- them has hidden it.
local function current(mark)
	local spec = vim.deepcopy(mark.spec)
	local found = vim.api.nvim_buf_get_extmark_by_id(spec.buf, mark.ns, mark.extmarks.span, { details = true })
	if not found[1] then
		return spec, false
	end
	local row, col, details = found[1], found[2], found[3]
	spec.line = row + 1
	if spec.col or spec.endCol then
		spec.endLine, spec.endCol = details.end_row + 1, details.end_col
		spec.col = col
		-- Its last line deleted, it ends where the next begins, and takes in none of that.
		if details.end_col == 0 and details.end_row > row then
			spec.endLine = details.end_row
			spec.endCol = #vim.api.nvim_buf_get_lines(spec.buf, row, details.end_row, true)[details.end_row - row]
		end
	else
		spec.endLine = math.max(spec.line, details.end_row)
	end
	-- Every line replaced, an extmark can be left past the last.
	local count = vim.api.nvim_buf_line_count(spec.buf)
	spec.line = math.min(spec.line, count)
	spec.endLine = math.max(spec.line, math.min(spec.endLine, count))
	return spec, details.invalid == true
end

-- Start the mark's `ttl` again; one counting already will not remove it.
local function arm(id, mark)
	mark.generation = (mark.generation or 0) + 1
	local generation = mark.generation
	if mark.spec.ttl then
		vim.defer_fn(function()
			if state.marks[id] and state.marks[id].generation == generation then
				remove(id)
			end
		end, mark.spec.ttl)
	end
end

-- Follow every change to `buf`, undo too, to sync its marks once it is done.
local function watch(buf)
	if state.watched[buf] then
		return
	end
	state.watched[buf] = true
	vim.api.nvim_buf_attach(buf, false, {
		on_lines = function()
			if state.closed then
				return true
			end
			if not state.queued[buf] then
				state.queued[buf] = true
				vim.schedule(function()
					state.queued[buf] = nil
					if not state.closed and vim.api.nvim_buf_is_valid(buf) then
						state.sync(buf)
					end
				end)
			end
		end,
		on_detach = function()
			state.watched[buf] = nil
		end,
	})
end

-- Draw `spec` as mark `id`, over what it was. `moved`: only moved, so a `ttl` runs on as it was.
local function install(id, group, spec, resolve, moved)
	local old = state.marks[id]
	if old and not moved then
		-- Drawn apart first: one that cannot be drawn fails before the old is touched.
		local trial = vim.deepcopy(spec)
		local ns, extmarks = draw(group, trial, resolve)
		delete(trial.buf, ns, extmarks)
	end
	local mark = { group = group, spec = spec, generation = old and old.generation }
	mark.ns, mark.extmarks, mark.anchor = draw(group, spec, resolve, old)
	-- What reloads look for is what it was placed on, not what edits have made of that since.
	if old and not resolve then
		mark.anchor = old.anchor
	end
	state.marks[id] = mark
	watch(spec.buf)
	if not moved then
		arm(id, mark)
	end
end

--- Place `marks` in `group`; returns their ids, in order. One that cannot be placed fails the
--- call, leaving those before it.
function state.place(group, marks)
	local ids = {}
	for _, spec in ipairs(marks) do
		state.next = state.next + 1
		install(state.next, group, spec, true)
		table.insert(ids, state.next)
	end
	return ids
end

local WHERE = { "path", "buf", "line", "endLine", "col", "endCol", "match" }

--- Change the mark `id` of `group` by `patch`: what it does not give stays, and `vim.NIL`
--- takes away. Lines and columns not given stay where edits have moved them. Returns
--- whether there was such a mark; one that cannot be changed so stays as it was.
function state.update(group, id, patch)
	local mark = state.marks[id]
	if not mark or mark.group ~= group then
		return false
	end
	local spec, invalid = current(mark)
	if patch.path then
		spec.buf = nil
	end
	for key, value in pairs(patch) do
		spec[key] = value ~= vim.NIL and value or nil
	end
	local moves = vim.iter(WHERE):any(function(key)
		return patch[key] ~= nil
	end)
	if invalid and not moves then
		-- Hidden by a deletion: only its own extmarks come back on undo, so they stay, and the
		-- change is drawn then. Drawn once now, to fail now if it cannot be.
		local trial = vim.deepcopy(spec)
		local ns, extmarks = draw(group, trial, false)
		delete(trial.buf, ns, extmarks)
		mark.spec, mark.stale = spec, true
		arm(id, mark)
		return true
	end
	-- Placed anew, a mark with a `match` looks for it; otherwise it keeps to its lines.
	install(id, group, spec, moves)
	return true
end

-- Whether a part of the mark is hidden by a deletion, or off the line it belongs on: each
-- `invalidate`s apart, and a point moves to another line when its own is deleted.
local function astray(mark, spec)
	for part, extmark in pairs(mark.extmarks) do
		local found = vim.api.nvim_buf_get_extmark_by_id(spec.buf, mark.ns, extmark, { details = true })
		local line = part == "text" and spec.position == "below" and (spec.endLine or spec.line) or spec.line
		if not found[1] or found[3].invalid or found[1] ~= line - 1 then
			return true
		end
	end
	return false
end

--- Redraw each mark in `buf` whose lines are not all deleted, but whose parts are astray or
--- which was changed while hidden.
function state.sync(buf)
	for id, mark in pairs(state.marks) do
		if mark.spec.buf == buf then
			local spec, invalid = current(mark)
			if not invalid and (mark.stale or astray(mark, spec)) then
				pcall(install, id, mark.group, spec, false, true)
			end
		end
	end
end

--- Pad filled lines anew, but those hidden by a deletion: drawn over, they would show again.
function state.refill()
	for id, mark in pairs(state.marks) do
		if mark.spec.fill and not mark.stale then
			local spec, invalid = current(mark)
			if not invalid then
				pcall(install, id, mark.group, spec, false, true)
			end
		end
	end
end

--- Move each mark in `buf` whose text is no longer on its lines to the nearest place it is,
--- showing one hidden by a deletion again, and drawing again one whose extmarks went with
--- the buffer (`:bdelete`); one that `invalidate`s goes if its text is nowhere.
function state.reanchor(buf)
	local text = text_of(buf)
	for id, mark in pairs(state.marks) do
		if mark.spec.buf == buf then
			local spec, invalid = current(mark)
			local gone = not vim.api.nvim_buf_get_extmark_by_id(buf, mark.ns, mark.extmarks.span, {})[1]
			local found = locate(text, mark.anchor, spec.line, not spec.match)
			if not found then
				if spec.invalidate then
					remove(id)
				elseif gone then
					install(id, mark.group, spec, false, true)
				end
			elseif found ~= spec.line or invalid or gone then
				spec.endLine = spec.endLine and spec.endLine + found - spec.line
				spec.line = found
				install(id, mark.group, spec, false, true)
			end
		end
	end
end

--- Remove the marks `ids` of `group` (of any group if nil); returns those that were there.
function state.remove(group, ids)
	group = group ~= vim.NIL and group or nil
	local removed = {}
	for _, id in ipairs(ids) do
		if state.marks[id] and (not group or state.marks[id].group == group) then
			remove(id)
			table.insert(removed, id)
		end
	end
	return removed
end

local function matching(group, filter)
	local buf = filter.buf or (filter.path and find(filter.path))
	local found = {}
	for id, mark in pairs(state.marks) do
		if (not group or mark.group == group) and (not buf or mark.spec.buf == buf) then
			found[id] = mark
		end
	end
	return found
end

--- The marks of `group` (every group if nil), only in the buffer of `path` or `buf` if given,
--- in order of placement: each with its id, buffer and file, where edits have moved it.
function state.list(group, filter)
	local marks = {}
	for id, mark in pairs(matching(group ~= vim.NIL and group or nil, filter)) do
		local spec, invalid = current(mark)
		spec.id, spec.group, spec.path = id, mark.group, vim.api.nvim_buf_get_name(spec.buf)
		spec.invalid = invalid or nil
		table.insert(marks, spec)
	end
	table.sort(marks, function(a, b)
		return a.id < b.id
	end)
	return marks
end

--- What there is, for `/nvim-virtual-text`: every mark as `list` gives it, `stale` if changed
--- while hidden; and how many buffers are watched and styles made.
function state.inspect()
	local marks = state.list(nil, {})
	for _, mark in ipairs(marks) do
		mark.stale = state.marks[mark.id].stale
	end
	return { marks = marks, watched = vim.tbl_count(state.watched), styles = vim.tbl_count(state.styles) }
end

--- Remove the marks `list` would give. Returns how many went.
function state.clear(group, filter)
	local removed = 0
	for id in pairs(matching(group ~= vim.NIL and group or nil, filter)) do
		remove(id)
		removed = removed + 1
	end
	return removed
end
