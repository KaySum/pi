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
	-- `marks[id]` is { group, spec, ns, extmarks, anchor, generation }: `spec` is the mark as
	-- given, its file resolved to `buf`; `extmarks[1]` spans its lines and moves with them, and
	-- `anchor` is the text it was placed on, found again when the file is reloaded.
	-- `styles` are the groups made from style tables.
	state = { namespaces = {}, marks = {}, styles = {}, next = 0 }
	remote.nvim_virtual_text = state
	remote.on_detach(function()
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

local function width_of(chunks)
	local width = 0
	for _, chunk in ipairs(chunks) do
		width = width + vim.fn.strdisplaywidth(chunk[1])
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

-- Break a line of chunks at spaces so that none is wider than `width`, where it can be.
local function wrap(chunks, width)
	local lines, used = { {} }, 0
	for _, chunk in ipairs(chunks) do
		for word, space in chunk[1]:gmatch("(%S*)(%s*)") do
			if word ~= "" or space ~= "" then
				if used > 0 and word ~= "" and used + vim.fn.strdisplaywidth(word) > width then
					table.insert(lines, {})
					used = 0
				end
				local line, piece = lines[#lines], word .. space
				local last = line[#line]
				if last and last[2] == chunk[2] then
					last[1] = last[1] .. piece
				else
					table.insert(line, { piece, chunk[2] })
				end
				used = used + vim.fn.strdisplaywidth(piece)
			end
		end
	end
	return lines
end

local function virtual_lines(buf, spec, row)
	local lines = lines_of(spec.text, highlight(spec.hl) or "PiVirtualText")
	local indent = 0
	if spec.indent == true then
		local text = vim.api.nvim_buf_get_lines(buf, row, row + 1, true)[1]
		indent = vim.api.nvim_buf_call(buf, function()
			return vim.fn.strdisplaywidth(text:match("^%s*"))
		end)
	elseif type(spec.indent) == "number" then
		indent = spec.indent
	end
	if spec.wrap then
		local wrapped = {}
		local most = (spec.wrap == true and text_width(buf) or spec.wrap) - indent
		for _, line in ipairs(lines) do
			vim.list_extend(wrapped, wrap(line, math.max(1, most)))
		end
		lines = wrapped
	end
	return vim.tbl_map(function(line)
		if indent > 0 then
			table.insert(line, 1, { string.rep(" ", indent) })
		end
		-- Virtual lines take no hl_eol. Padded to the editor's width, which is cut to the
		-- window's, the background fills any window showing them, however it is resized.
		if spec.fill and #line > 0 then
			local padding = math.max(0, vim.o.columns - width_of(line))
			table.insert(line, { string.rep(" ", padding), line[#line][2] })
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

local function holds(lines, needles, line)
	for i, needle in ipairs(needles) do
		local text = lines[line + i - 1]
		if not (text and vim.trim(text):find(needle, 1, true)) then
			return false
		end
	end
	return true
end

-- The line nearest `near` where `needles` start, earlier on a tie.
local function locate(buf, needles, near)
	local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, true)
	near = math.max(1, math.min(near, #lines))
	if holds(lines, needles, near) then
		return near
	end
	for distance = 1, #lines do
		for _, line in ipairs({ near - distance, near + distance }) do
			if line >= 1 and holds(lines, needles, line) then
				return line
			end
		end
	end
end

-- Draw `spec`; returns its namespace, extmarks and anchor. `strict`: a `match` not found
-- fails, rather than leave the mark where it was.
local function draw(group, spec, strict)
	local buf, ns = buffer(spec), namespace(group)
	spec.buf, spec.path = buf, nil
	local needles = spec.match and needles_of(spec.match)
	if needles then
		local found = locate(buf, needles, spec.line or 1)
		if not found and (strict or not spec.line) then
			error(("not found in %s: %s"):format(vim.api.nvim_buf_get_name(buf), spec.match), 0)
		end
		spec.line = found or spec.line
		spec.endLine = spec.line + #needles - 1
	end
	local count = vim.api.nvim_buf_line_count(buf)
	local function row(line)
		return math.max(1, math.min(line, count)) - 1
	end
	local first, last = row(spec.line), row(spec.endLine or spec.line)
	local anchor = needles
		or vim.tbl_map(vim.trim, vim.api.nvim_buf_get_lines(buf, first, last + 1, true))
	local base = { priority = spec.priority, invalidate = spec.invalidate, strict = false }

	-- Whole lines unless columns are given: then a span of characters.
	local span = vim.tbl_extend("force", base, { hl_group = highlight(spec.highlight) })
	local col = 0
	if spec.col or spec.endCol then
		col = spec.col or 0
		span.end_row = last
		span.end_col = spec.endCol or #vim.api.nvim_buf_get_lines(buf, last, last + 1, true)[1]
	else
		span.end_row, span.end_col, span.hl_eol = last + 1, 0, spec.highlight ~= nil
	end
	if spec.sign then
		local sign = type(spec.sign) == "string" and { spec.sign } or spec.sign
		span.sign_text = sign[1]
		span.sign_hl_group = highlight(sign[2]) or highlight(spec.hl) or "PiVirtualText"
	end
	local extmarks = { vim.api.nvim_buf_set_extmark(buf, ns, first, col, span) }

	if spec.text then
		local position = spec.position or "eol"
		local at, opts = position == "below" and last or first, nil
		if position == "above" or position == "below" then
			opts = { virt_lines = virtual_lines(buf, spec, at), virt_lines_above = position == "above" }
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
		local at_col = (position == "overlay" or position == "inline") and spec.col or 0
		table.insert(extmarks, vim.api.nvim_buf_set_extmark(buf, ns, at, at_col, vim.tbl_extend("force", base, opts)))
	end
	return ns, extmarks, anchor
end

local function erase(mark)
	for _, extmark in ipairs(mark.extmarks) do
		pcall(vim.api.nvim_buf_del_extmark, mark.spec.buf, mark.ns, extmark)
	end
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
	local found = vim.api.nvim_buf_get_extmark_by_id(spec.buf, mark.ns, mark.extmarks[1], { details = true })
	if not found[1] then
		return spec, false
	end
	local row, col, details = found[1], found[2], found[3]
	spec.line = row + 1
	if spec.col or spec.endCol then
		spec.endLine, spec.endCol = details.end_row + 1, details.end_col
		spec.col = col
	else
		spec.endLine = math.max(spec.line, details.end_row)
	end
	return spec, details.invalid == true
end

-- Draw `spec` as mark `id`. `moved`: only moved, so a `ttl` runs on as it was.
local function draw_as(id, group, spec, strict, moved)
	local generation = (state.marks[id] or { generation = 0 }).generation
	local mark = { group = group, spec = spec, generation = moved and generation or generation + 1 }
	mark.ns, mark.extmarks, mark.anchor = draw(group, spec, strict)
	state.marks[id] = mark
	if spec.ttl and not moved then
		vim.defer_fn(function()
			if state.marks[id] and state.marks[id].generation == mark.generation then
				remove(id)
			end
		end, spec.ttl)
	end
end

--- Place `marks` in `group`; returns their ids, in order. One that cannot be placed fails the
--- call, leaving those before it.
function state.place(group, marks)
	local ids = {}
	for _, spec in ipairs(marks) do
		state.next = state.next + 1
		draw_as(state.next, group, spec, true)
		table.insert(ids, state.next)
	end
	return ids
end

--- Change the mark `id` of `group` by `patch`: what it does not give stays, and `vim.NIL`
--- takes away. Lines and columns not given stay where edits have moved them. Returns
--- whether there was such a mark; one that cannot be changed so stays as it was.
function state.update(group, id, patch)
	local mark = state.marks[id]
	if not mark or mark.group ~= group then
		return false
	end
	local before = current(mark)
	local spec = vim.deepcopy(before)
	if patch.path then
		spec.buf = nil
	end
	for key, value in pairs(patch) do
		spec[key] = value ~= vim.NIL and value or nil
	end
	erase(mark)
	local ok, err = pcall(draw_as, id, group, spec, patch.match ~= nil)
	if not ok then
		draw_as(id, group, before, false, true)
		error(err, 0)
	end
	return true
end

--- Move each mark in `buf` whose text is no longer on its lines to the nearest place it is;
--- one that `invalidate`s goes if its text is nowhere.
function state.reanchor(buf)
	for id, mark in pairs(state.marks) do
		if mark.spec.buf == buf then
			local spec = current(mark)
			local found = locate(buf, mark.anchor, spec.line)
			if not found and spec.invalidate then
				remove(id)
			elseif found and found ~= spec.line then
				spec.endLine = spec.endLine and spec.endLine + found - spec.line
				spec.line = found
				erase(mark)
				draw_as(id, mark.group, spec, false, true)
			end
		end
	end
end

function state.remove(group, ids)
	for _, id in ipairs(ids) do
		if state.marks[id] and state.marks[id].group == group then
			remove(id)
		end
	end
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

--- Remove the marks `list` would give. Returns how many went.
function state.clear(group, filter)
	local removed = 0
	for id in pairs(matching(group ~= vim.NIL and group or nil, filter)) do
		remove(id)
		removed = removed + 1
	end
	return removed
end
