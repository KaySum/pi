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
	-- `marks[id]` is { group, buf, ns, extmarks }; `styles` are the groups made from style tables.
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

-- The buffer of `mark.buf`, or of the file at `mark.path`: loaded but not listed if the user
-- has not opened it, so marks are there when they do.
local function buffer(mark)
	if mark.buf then
		return vim.api.nvim_buf_is_valid(mark.buf) and mark.buf or error(("no buffer %d"):format(mark.buf), 0)
	end
	if vim.fn.bufexists(mark.path) == 0 and not vim.uv.fs_stat(mark.path) then
		error(("no such file: %s"):format(mark.path), 0)
	end
	local buf = vim.fn.bufadd(mark.path)
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

-- Virtual lines take no hl_eol: pad in display cells to the widest window showing the buffer.
local function filled(buf, chunks)
	local width = 0
	for _, win in ipairs(vim.fn.win_findbuf(buf)) do
		width = math.max(width, vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff)
	end
	local text = table.concat(vim.tbl_map(function(chunk)
		return chunk[1]
	end, chunks))
	local last = chunks[#chunks] or { "", "PiVirtualText" }
	local padding = math.max(0, width - vim.fn.strdisplaywidth(text))
	return vim.list_extend(vim.deepcopy(chunks), { { string.rep(" ", padding), last[2] } })
end

local function place(group, mark)
	local buf, ns = buffer(mark), namespace(group)
	local count = vim.api.nvim_buf_line_count(buf)
	local function row(line)
		return math.max(1, math.min(line, count)) - 1
	end
	local first, last = row(mark.line), row(mark.endLine or mark.line)
	local base = { priority = mark.priority, strict = false }
	local extmarks = {}

	if mark.highlight then
		local opts = vim.tbl_extend("force", base, { hl_group = highlight(mark.highlight) })
		local col = 0
		if mark.col or mark.endCol then
			col = mark.col or 0
			opts.end_row = last
			opts.end_col = mark.endCol or #vim.api.nvim_buf_get_lines(buf, last, last + 1, true)[1]
		else
			opts.end_row, opts.end_col, opts.hl_eol = last + 1, 0, true
		end
		table.insert(extmarks, vim.api.nvim_buf_set_extmark(buf, ns, first, col, opts))
	end

	if mark.lines then
		local default = highlight(mark.hl) or "PiVirtualText"
		local lines = vim.tbl_map(function(line)
			local chunks = vim.tbl_map(function(chunk)
				return { chunk[1], highlight(chunk[2]) or default }
			end, line)
			return mark.fill and filled(buf, chunks) or chunks
		end, mark.lines)
		local position = mark.position or "eol"
		local opts
		if position == "above" or position == "below" then
			opts = { virt_lines = lines, virt_lines_above = position == "above" }
		else
			opts = { virt_text = lines[1], virt_text_pos = POSITIONS[position], hl_mode = "combine" }
		end
		local at = position == "below" and last or first
		local col = (position == "overlay" or position == "inline") and mark.col or 0
		table.insert(extmarks, vim.api.nvim_buf_set_extmark(buf, ns, at, col, vim.tbl_extend("force", base, opts)))
	end

	state.next = state.next + 1
	state.marks[state.next] = { group = group, buf = buf, ns = ns, extmarks = extmarks }
	return state.next
end

local function remove(id)
	local mark = state.marks[id]
	if not mark then
		return
	end
	state.marks[id] = nil
	for _, extmark in ipairs(mark.extmarks) do
		pcall(vim.api.nvim_buf_del_extmark, mark.buf, mark.ns, extmark)
	end
end

--- Place `marks` in `group`; returns their ids, in order. One that cannot be placed fails the
--- call, leaving those before it.
function state.place(group, marks)
	local ids = {}
	for _, mark in ipairs(marks) do
		local id = place(group, mark)
		table.insert(ids, id)
		if mark.ttl then
			vim.defer_fn(function()
				remove(id)
			end, mark.ttl)
		end
	end
	return ids
end

function state.remove(ids)
	for _, id in ipairs(ids) do
		remove(id)
	end
end

--- Remove the marks of `group` (every group if nil), only in the buffer of `path` or `buf` if given.
--- Returns how many went.
function state.clear(group, filter)
	group = group ~= vim.NIL and group or nil
	local buf = filter.buf or (filter.path and vim.fn.bufnr(filter.path))
	local removed = 0
	for id, mark in pairs(state.marks) do
		if (not group or mark.group == group) and (not buf or mark.buf == buf) then
			remove(id)
			if vim.api.nvim_buf_is_valid(mark.buf) then
				removed = removed + 1
			end
		end
	end
	return removed
end
