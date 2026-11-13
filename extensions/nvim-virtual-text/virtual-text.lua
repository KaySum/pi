-- Installs `remote.nvim_virtual_text`, once for each attachment: api.ts calls into it by name
-- afterwards. It runs through nvim-remote, with `remote` in scope. Each group (one for each
-- extension using it, say) has its own namespace; every mark placed has an id of its own, and
-- all of them go when Pi detaches.

local POSITIONS = { eol = "eol", right = "right_align", overlay = "overlay", inline = "inline", after = "inline" }
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
	-- `marks[id]` is { group, spec, given, ns, extmarks, anchor, generation, stale }: `given` is
	-- the mark as last given (placed, updated or set), for `set` to tell a change by; `spec` is the mark as
	-- given, its file resolved to `buf`; `extmarks` by part (`span`, `gutter`, `sign`, `text`), the span
	-- covering its lines and moving with them; and
	-- `anchor` is the text it was placed on, found again when the file is reloaded. `stale`:
	-- changed while hidden by a deletion, drawn as it was.
	-- `styles` are the groups made from style tables; `watched`, the buffers whose changes
	-- are followed, and `queued` those with a sync to come.
	state = { namespaces = {}, marks = {}, styles = {}, next = 0, watched = {}, queued = {}, saved = {}, windowed = {} }
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
			state.forget(ev.buf)
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
	-- Undoing a reload brings its old text back, not where the marks were in it: saved before
	-- and after each, by the undo state, they are put back when undo or redo comes to one.
	vim.api.nvim_create_autocmd("BufReadPre", {
		group = remote.group,
		callback = function(ev)
			state.save(ev.buf, true)
		end,
	})
	vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
		group = remote.group,
		callback = function(ev)
			state.restore(ev.buf)
		end,
	})
	-- Filled lines are padded to the editor's width, which has changed.
	vim.api.nvim_create_autocmd("VimResized", {
		group = remote.group,
		callback = function()
			state.refill()
		end,
	})
	-- Lines wrapped to the windows showing their buffer are wrapped again once those change:
	-- after the event, when a closed window is gone, and once for several.
	local function rewrap()
		if not state.rewrapping then
			state.rewrapping = true
			vim.schedule(function()
				state.rewrapping = false
				if not state.closed then
					state.rewrap()
				end
			end)
		end
	end
	vim.api.nvim_create_autocmd({ "WinResized", "VimResized", "WinClosed", "BufWinEnter" }, {
		group = remote.group,
		callback = rewrap,
	})
	-- And once how the windows wrap text changes, for those wrapped as their windows do.
	vim.api.nvim_create_autocmd("OptionSet", {
		group = remote.group,
		pattern = {
			"wrap", "linebreak", "breakat", "breakindent", "breakindentopt", "showbreak",
			"tabstop", "vartabstop", "ambiwidth", "emoji", "display", "isprint",
		},
		callback = rewrap,
	})
	-- And once a window's text width changes as its gutter grows or shrinks (numbers, signs as
	-- they come and go, folds), or characters' widths by setcellwidths(), of which no event tells:
	-- looked at once each window showing marks wrapped as their windows do has been drawn, as its
	-- gutter is only known by then.
	local widths, cellwidths, looking = {}, nil, false
	local function look()
		looking = false
		if state.closed then
			return
		end
		local now, changed = {}, false
		for _, win in ipairs(vim.api.nvim_list_wins()) do
			if state.windowed[vim.api.nvim_win_get_buf(win)] then
				now[win] = vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff
				changed = changed or widths[win] ~= now[win]
			end
		end
		widths = now
		local given = vim.inspect(vim.fn.getcellwidths())
		changed = changed or cellwidths ~= given
		cellwidths = given
		-- rewrap() redraws only marks whose layout is not as measured.
		if changed then
			rewrap()
		end
	end
	-- Named apart from the groups' (nvim-virtual-text.<channel>.<group>): a group may be "widths".
	local drawing = vim.api.nvim_create_namespace(("nvim-virtual-text-widths.%d"):format(remote.channel))
	vim.api.nvim_set_decoration_provider(drawing, {
		on_win = function(_, _, buf)
			if not looking and not state.closed and state.windowed[buf] then
				looking = true
				vim.schedule(look)
			end
			return false
		end,
	})
	remote.on_detach(function()
		vim.api.nvim_set_decoration_provider(drawing, {})
	end)
end

-- Forget `buf`'s marks and what is kept for them: it is wiped.
function state.forget(buf)
	for id, mark in pairs(state.marks) do
		if mark.spec.buf == buf then
			state.marks[id] = nil
		end
	end
	state.saved[buf] = nil
	state.watched[buf] = nil
	state.windowed[buf] = nil
end

-- Forget the buffers wiped with no BufWipeout reaching us (from a user's autocommand, one not
-- nested, Neovim fires none): those of marks, and those with positions saved, marks or not.
function state.prune()
	for _, mark in pairs(state.marks) do
		if not vim.api.nvim_buf_is_valid(mark.spec.buf) then
			state.forget(mark.spec.buf)
		end
	end
	for buf in pairs(state.saved) do
		if not vim.api.nvim_buf_is_valid(buf) then
			state.forget(buf)
		end
	end
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

-- The buffer of the file at `path`, by any name of it (see the kit's `file`); -1 if none.
local function find(path)
	local is = remote.kit.file(path)
	return vim.iter(vim.api.nvim_list_bufs()):find(is) or -1
end

-- The buffer of `spec.buf`, or of the file at `spec.path`: loaded but not listed if the user
-- has not opened it, so marks are there when they do; and what was done for it, to undo if its
-- mark fails (see nvim-remote-kit, installed before this).
local function buffer(spec)
	if spec.path then
		return remote.kit.open(spec.path)
	end
	return vim.api.nvim_buf_is_valid(spec.buf) and spec.buf or error(("no buffer %d"):format(spec.buf), 0)
end

-- Columns of text in the narrowest window showing `buf`, else in the editor.
local function text_width(buf)
	local width = 0
	for _, win in ipairs(vim.fn.win_findbuf(buf)) do
		width = math.max(width, vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff)
	end
	return width > 0 and width or vim.o.columns
end

-- How the narrowest window showing `buf` wraps its text (with none, the global options): its
-- width and 'wrap', 'linebreak' at 'breakat', 'breakindent' with 'breakindentopt' and
-- 'showbreak', each as that window has it. Virtual lines are the buffer's, the same in every
-- window: wrapped for the narrowest, they are whole in each, where for a wider one they would
-- be cut off in the rest.
local function layout_of(buf)
	local narrowest, width = nil, math.huge
	for _, win in ipairs(vim.fn.win_findbuf(buf)) do
		local w = vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff
		if w < width then
			narrowest, width = win, w
		end
	end
	local function read()
		local layout = { width = narrowest and width or vim.o.columns, breakat = vim.o.breakat, shift = 0, min = 20 }
		-- The buffer's tab stops, which tabs and the code's indent are measured by.
		layout.tabstop, layout.vartabstop = vim.bo[buf].tabstop, vim.bo[buf].vartabstop
		-- And how characters are drawn and how wide: ambiguous ones, such as '·', and emoji; any
		-- given widths by setcellwidths(); and as what ('display' "uhex", 'isprint').
		layout.ambiwidth, layout.emoji = vim.o.ambiwidth, vim.o.emoji
		layout.cellwidths = vim.inspect(vim.fn.getcellwidths())
		layout.display, layout.isprint = vim.o.display, vim.o.isprint
		local o = narrowest and vim.o or vim.go
		layout.wrap, layout.linebreak, layout.showbreak = o.wrap, o.linebreak, o.showbreak
		layout.breakindent = o.breakindent
		for _, item in ipairs(vim.split(o.breakindentopt, ",", { trimempty = true })) do
			local key, value = item:match("^(%a+):?(-?%d*)$")
			if key == "shift" or key == "min" then
				layout[key] = tonumber(value) or layout[key]
			elseif key == "sbr" then
				layout.sbr = true
			end
		end
		return layout
	end
	return narrowest and vim.api.nvim_win_call(narrowest, read) or read()
end

-- What a mark wrapped to its windows was measured against, to wrap it again once it changes.
local function measure(spec)
	if spec.wrap == true then
		return tostring(text_width(spec.buf))
	elseif spec.wrap == "window" then
		return vim.inspect(layout_of(spec.buf))
	end
end

-- Cells a tab at column `col` takes in the current buffer: to its next stop, by 'vartabstop'
-- when it is set (its widths in turn, then the last again and again), else 'tabstop'.
local function tab(col)
	local widths = vim.tbl_map(tonumber, vim.split(vim.bo.vartabstop, ",", { trimempty = true }))
	if #widths == 0 then
		return vim.bo.tabstop - col % vim.bo.tabstop
	end
	local stop = 0
	for _, width in ipairs(widths) do
		stop = stop + width
		if stop > col then
			return stop - col
		end
	end
	local last = widths[#widths]
	return last - (col - stop) % last
end

-- Cells `text` takes from column `col`, as Neovim draws it: a tab to its next stop (see `tab`).
-- Not strdisplaywidth(), which near the current window's edge counts that window's own
-- wrapping in ('breakindent', 'showbreak').
local function cells(text, col)
	if not text:find("\t", 1, true) then
		return vim.api.nvim_strwidth(text)
	end
	local width = 0
	for _, char in ipairs(vim.fn.split(text, "\\zs")) do
		width = width + (char == "\t" and tab(col + width) or vim.api.nvim_strwidth(char))
	end
	return width
end

-- Measured in sequence: a tab's width depends on the column it starts at.
local function width_of(chunks)
	local width = 0
	for _, chunk in ipairs(chunks) do
		width = width + cells(chunk[1], width)
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

-- Break a line of chunks at spaces so that none ends past column `limit`, where it can be, the
-- line starting at column `start`, those after it at `cont`. A word is whole across chunks: a
-- change of highlight is no place to break. Widths are measured where the text falls, for tabs.
-- Each line as { chunks, continued }.
local function wrap(chunks, limit, start, cont)
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
				col = col + cells(piece[1], col)
			end
		end
		return col
	end
	local lines, col = { { {} } }, start
	for _, word in ipairs(words) do
		local ends = after(word.pieces, col, false)
		if col > (#lines == 1 and start or cont) and ends > col and ends > limit then
			table.insert(lines, { {}, true })
			col = cont
		end
		local line = lines[#lines][1]
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

-- The characters of `text` as Neovim draws them: its bytes when it is ASCII, as most is, at no
-- call to Vimscript; else as \\zs splits it, which keeps a grapheme (combining marks, joined
-- emoji) whole.
local function characters(text)
	if not text:find("[\128-\255]") then
		local found = {}
		for i = 1, #text do
			found[i] = text:sub(i, i)
		end
		return found
	end
	return vim.fn.split(text, "\\zs")
end

-- Rows of a line of chunks as Neovim wraps a line of code (plines.c, charsize_regular), the
-- line starting at column `start`, those after it at `cont`, each `limit` wide. Each character
-- has a size, from its column `vcol` in the whole line: a tab to its next stop; a wide one that
-- would start in a row's last cell, one more for the '>' left there; and with `linebreak`, a
-- break character before a word that would not fit is stretched to the row's end. Each line as
-- { chunks, continued }, a tab drawn as its spaces.
local function wrap_native(chunks, limit, start, cont, linebreak, breakat)
	local chars = {}
	for _, chunk in ipairs(chunks) do
		for _, char in ipairs(characters(chunk[1])) do
			local byte = #char == 1 and char:byte()
			local control = byte and char ~= "\t" and (byte < 32 or byte == 127)
			if control or (not byte and vim.fn.strtrans(char) ~= char) then
				-- As Neovim draws it (^A, <80>), in SpecialKey: cells like any, though no break.
				for _, cell in ipairs(characters(vim.fn.strtrans(char))) do
					table.insert(chars, { cell, "SpecialKey", shown = true })
				end
			else
				table.insert(chars, { char, chunk[2] })
			end
		end
	end
	local function isbreak(entry)
		return not entry.shown and breakat[entry[1]] == true
	end
	-- 'linebreak' does not apply in the line's leading whitespace.
	local lead = 1
	while chars[lead] and isbreak(chars[lead]) do
		lead = lead + 1
	end
	local function width(char, vcol)
		if char == "\t" then
			return tab(vcol)
		end
		-- An ASCII character is one cell (as nvim_strwidth() has it), without asking.
		return #char == 1 and 1 or vim.api.nvim_strwidth(char)
	end
	local lines, col = { { {} } }, start
	local function put(text, hl)
		local line = lines[#lines][1]
		local last = line[#line]
		if last and last[2] == hl then
			last[1] = last[1] .. text
		else
			table.insert(line, { text, hl })
		end
	end
	local function newrow()
		table.insert(lines, { {}, true })
		col = cont
	end
	for i, entry in ipairs(chars) do
		local char, hl = entry[1], entry[2]
		-- Its column in the whole line, before the next row's prefix if it starts that row:
		-- Neovim counts the prefix in the size of the character it comes before.
		local head = col >= limit and cont or 0
		local vcol = (#lines - 1) * limit + col
		local base = width(char, vcol)
		local size = base + head
		local marker = 0
		if base == 2 and (col >= limit and cont or col) == limit - 1 then
			marker, size = 1, size + 1 -- The '>' in the last cell.
		end
		local stretched = false
		if linebreak and i >= lead and isbreak(entry) and chars[i + 1] and not isbreak(chars[i + 1]) then
			-- Neovim's colmax: where the row this character ends in ends, less its extra cells.
			local adj = size - 1
			local colmax = limit - adj
			if vcol >= colmax then
				colmax = limit + (math.floor((vcol + adj - limit) / limit) + 1) * limit - adj
			end
			-- The word after it and the break characters after that, as if from its own column.
			local vcol2, j = vcol, i
			while true do
				local next = chars[j + 1]
				if not next or not (isbreak(next) or vcol2 == vcol or not isbreak(chars[j])) then
					break
				end
				j = j + 1
				vcol2 = vcol2 + width(next[1], vcol2)
				if vcol2 >= colmax then
					size, stretched = colmax - vcol + adj, true
					break
				end
			end
		end
		-- Laid out: the prefix of a new row, then the character, then what stretches it.
		if col >= limit then
			newrow()
		end
		if marker == 1 then
			put(">", "NonText")
			newrow()
		end
		local shown = size - head - marker
		if stretched then
			-- To the row's end, left blank as Neovim leaves it: the character, a tab being blank.
			if char ~= "\t" then
				put(char, hl)
			end
			col = col + shown
		elseif char == "\t" or base == 0 then
			for _ = 1, shown do
				if col >= limit then
					newrow()
				end
				put(" ", hl)
				col = col + 1
			end
		else
			put(char, hl)
			col = col + base
			for _ = 1, shown - base do
				if col >= limit then
					newrow()
				end
				put(" ", hl)
				col = col + 1
			end
		end
	end
	return lines
end

local function virtual_lines(buf, spec, row)
	local default = highlight(spec.hl) or "PiVirtualText"
	local lines = lines_of(spec.text, default)
	local indent = 0
	if spec.indent == true then
		indent = vim.fn.indent(row + 1) -- As Neovim measures it, tab stops and all.
	elseif type(spec.indent) == "number" then
		indent = spec.indent
	end
	-- Where the rows after the first of a wrapped line start, and what comes before them.
	local before = nil
	local layout = spec.wrap == "window" and layout_of(buf)
	if spec.wrap and not (layout and not layout.wrap) then
		local limit, breakat = spec.wrap, {}
		-- As the window wraps its code: 'breakindent' keeps a line's indent, shifted, so that at
		-- least `min` columns are left; 'showbreak' goes before it with "sbr", else after it. In
		-- Neovim's order: the indent and shift, less 'showbreak' with "sbr", at least 0 and
		-- leaving `min` columns, then 'showbreak'. A line's indent is the code's and its own.
		local function continuation(line)
			if not layout then
				return indent
			end
			local text = table.concat(vim.tbl_map(function(chunk)
				return chunk[1]
			end, line))
			local own = indent + cells(text:match("^[ \t]*"), indent)
			local mark = cells(layout.showbreak, 0)
			local shown = layout.breakindent and math.max(0, own + layout.shift - (layout.sbr and mark or 0)) or 0
			if shown > layout.width - layout.min then
				shown = math.max(0, layout.width - layout.min)
			end
			return shown + mark
		end
		if layout then
			limit = layout.width
			for _, char in ipairs(vim.fn.split(layout.breakat, "\\zs")) do
				breakat[char] = true
			end
			before = layout.showbreak
		elseif spec.wrap == true then
			limit = text_width(buf)
		end
		local wrapped = {}
		for _, line in ipairs(lines) do
			local cont = continuation(line)
			local width = math.max(indent + 1, cont + 1, limit)
			for _, row in ipairs(layout and wrap_native(line, width, indent, cont, layout.linebreak, breakat)
				or wrap(line, width, indent, cont)) do
				row[3] = cont
				table.insert(wrapped, row)
			end
		end
		lines = wrapped
	else
		lines = vim.tbl_map(function(line)
			return { line }
		end, lines)
	end
	-- Filled, a line's background is `hl`'s from edge to edge: indentation, blank lines and all.
	local background = spec.fill and default or nil
	return vim.tbl_map(function(entry)
		local line, continued, cont = entry[1], entry[2], entry[3] or indent
		local prefix = { { string.rep(" ", continued and cont or indent), background } }
		if continued and before then
			-- 'showbreak' as Neovim draws it, in NonText, before the indent with "sbr", else after.
			local pad = { string.rep(" ", cont - cells(layout.showbreak, 0)), background }
			local mark = { layout.showbreak, "NonText" }
			prefix = layout.sbr and { mark, pad } or { pad, mark }
		end
		for k = #prefix, 1, -1 do
			if prefix[k][1] ~= "" then
				table.insert(line, 1, prefix[k])
			end
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

-- Where `needles`, found from `line` on, start and end: byte columns in the real lines, tabs,
-- indentation and all, at the first place on each.
local function columns_of(buf, needles, line)
	local lines = vim.api.nvim_buf_get_lines(buf, line - 1, line - 1 + #needles, true)
	local start = lines[1]:find(needles[1], 1, true)
	local _, finish = lines[#lines]:find(needles[#needles], #needles == 1 and start or 1, true)
	return start - 1, finish
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

-- Where on its line text in `position` goes: before the mark's columns, after them, or at 0.
local function text_col(buf, spec, last)
	local position = spec.position
	if position == "overlay" or position == "inline" then
		return spec.col or 0
	elseif position == "after" then
		return spec.endCol or #vim.api.nvim_buf_get_lines(buf, last, last + 1, true)[1]
	end
	return 0
end

-- `reuse`: the extmarks to draw over, by part, keeping their ids.
local function render(buf, ns, spec, resolve, extmarks, reuse)
	local needles = spec.match and needles_of(spec.match)
	if needles and resolve then
		spec.line = locate(text_of(buf), needles, spec.line or 1)
			or error(("not found in %s: %s"):format(vim.api.nvim_buf_get_name(buf), spec.match), 0)
		spec.endLine = spec.line + #needles - 1
		if spec.columns then
			spec.col, spec.endCol = columns_of(buf, needles, spec.line)
		end
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

	-- Over the marked lines, and no further: these show on every line an extmark spans, its end
	-- included.
	if spec.numberHl or spec.lineHl then
		put("gutter", first, 0, {
			end_row = last,
			end_col = 0,
			number_hl_group = highlight(spec.numberHl),
			line_hl_group = highlight(spec.lineHl),
		})
	end

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
		local at, opts = (position == "below" or position == "after") and last or first, nil
		if position == "above" or position == "below" then
			-- Measured as that buffer shows text: its 'tabstop', not the current buffer's.
			local lines = vim.api.nvim_buf_call(buf, function()
				return virtual_lines(buf, spec, at)
			end)
			opts = { virt_lines = lines, virt_lines_above = position == "above" }
			-- Not wrapped as its window does not wrap: it scrolls sideways with the code.
			if spec.wrap == "window" and not layout_of(buf).wrap then
				opts.virt_lines_overflow = "scroll"
			end
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
		-- Text inserted where the mark ends goes after `after`'s text, as after the mark's end.
		opts.right_gravity = position ~= "after"
		put("text", at, text_col(buf, spec, last), opts)
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
	local buf, done = buffer(spec)
	local ns = namespace(group)
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
		remote.kit.undo(buf, done)
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
-- Where `mark` is now; or, given `found` (its span's extmark as saved, see `positions`), then.
local function current(mark, found)
	local spec = vim.deepcopy(mark.spec)
	found = found or vim.api.nvim_buf_get_extmark_by_id(spec.buf, mark.ns, mark.extmarks.span, { details = true })
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
			-- A reload by :checktime (autoread) detaches it after BufReadPost, when it was still
			-- watched: watched again, next, if still loaded with marks (unloaded, it is not).
			vim.schedule(function()
				if state.closed then
					return
				elseif not vim.api.nvim_buf_is_valid(buf) then
					return state.forget(buf)
				elseif not vim.api.nvim_buf_is_loaded(buf) then
					return
				end
				for _, mark in pairs(state.marks) do
					if mark.spec.buf == buf then
						return watch(buf)
					end
				end
			end)
		end,
	})
end

-- Draw `spec` as mark `id`, over what it was. `moved`: only moved, so a `ttl` runs on as it was.
-- The indent a mark's lines above or below its code are drawn at, with `indent = true`: that of
-- the line they go by, as Neovim measures it. Nil for any other mark.
local function indented(spec)
	if spec.indent ~= true or not (spec.position == "above" or spec.position == "below") then
		return nil
	end
	local line = spec.position == "below" and (spec.endLine or spec.line) or spec.line
	return vim.api.nvim_buf_call(spec.buf, function()
		return vim.fn.indent(line)
	end)
end

local function install(id, group, spec, resolve, moved)
	local old = state.marks[id]
	if old and not moved then
		-- Drawn apart first: one that cannot be drawn fails before the old is touched.
		local trial = vim.deepcopy(spec)
		local ns, extmarks = draw(group, trial, resolve)
		delete(trial.buf, ns, extmarks)
	end
	local mark = { group = group, spec = spec, given = old and old.given, generation = old and old.generation }
	mark.ns, mark.extmarks, mark.anchor = draw(group, spec, resolve, old)
	-- Wrapped to the windows showing it, what it was wrapped to (see `rewrap`).
	mark.measure, mark.indented = measure(spec), indented(spec)
	if spec.wrap == "window" then
		state.windowed[spec.buf] = true
	end
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
	state.prune()
	local ids = {}
	for _, spec in ipairs(marks) do
		local given = vim.deepcopy(spec)
		state.next = state.next + 1
		install(state.next, group, spec, true)
		state.marks[state.next].given = given
		table.insert(ids, state.next)
	end
	return ids
end

local WHERE = { "path", "buf", "line", "endLine", "col", "endCol", "match", "columns" }

--- Change the mark `id` of `group` by `patch`: what it does not give stays, and `vim.NIL`
--- takes away. Lines and columns not given stay where edits have moved them. Returns
--- whether there was such a mark; one that cannot be changed so stays as it was.
function state.update(group, id, patch)
	state.prune()
	local mark = state.marks[id]
	if not mark or mark.group ~= group then
		return false
	end
	local spec, invalid = current(mark)
	local given = vim.deepcopy(mark.given or {})
	if patch.path then
		spec.buf, given.buf = nil, nil
	elseif patch.buf then
		given.path = nil
	end
	for key, value in pairs(patch) do
		if value == vim.NIL then
			value = nil -- Taken away; `false` is a value, kept.
		end
		spec[key], given[key] = value, value
	end
	-- Turned off, `columns` takes the columns the match gave with it; any given stay.
	if patch.columns ~= nil and not spec.columns and (mark.given or {}).columns then
		spec.col, spec.endCol = given.col, given.endCol
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
		mark.spec, mark.given, mark.stale = spec, given, true
		arm(id, mark)
		return true
	end
	-- Placed anew, a mark with a `match` looks for it; otherwise it keeps to its lines.
	install(id, group, spec, moves)
	state.marks[id].given = given
	return true
end

--- Make `marks` the marks of `group`, returning their ids in order. One with the `key` of a
--- mark there is that mark: left as it is, wherever edits have moved it, if given just as it
--- last was, else drawn as now given. The rest are placed, and the group's other marks go.
--- Checked first: one that cannot be drawn fails the call before anything changes. A failure
--- of Neovim's own while writing, after that, is not undone.
function state.set(group, marks)
	state.prune()
	local keyed, seen, plan = {}, {}, {}
	for id, mark in pairs(state.marks) do
		if mark.group == group and mark.given and mark.given.key then
			keyed[mark.given.key] = id
		end
	end
	for i, spec in ipairs(marks) do
		if spec.key then
			if seen[spec.key] then
				error(("key given twice: %s"):format(spec.key), 0)
			end
			seen[spec.key] = true
		end
		local id = spec.key and keyed[spec.key]
		local same = id and vim.deep_equal(state.marks[id].given, spec)
		if not same then
			local trial = vim.deepcopy(spec)
			local ns, extmarks = draw(group, trial, true)
			delete(trial.buf, ns, extmarks)
		end
		plan[i] = { id = id, same = same }
	end
	local ids, kept = {}, {}
	for i, spec in ipairs(marks) do
		local id = plan[i].id
		if not id then
			state.next = state.next + 1
			id = state.next
		end
		if not plan[i].same then
			local given = vim.deepcopy(spec)
			install(id, group, spec, true)
			state.marks[id].given = given
		end
		ids[i], kept[id] = id, true
	end
	for id, mark in pairs(state.marks) do
		if mark.group == group and not kept[id] then
			remove(id)
		end
	end
	return ids
end

-- Whether a part of the mark is hidden by a deletion, or off the line it belongs on: each
-- `invalidate`s apart, and a point moves to another line when its own is deleted.
local function astray(mark, spec)
	for part, extmark in pairs(mark.extmarks) do
		local found = vim.api.nvim_buf_get_extmark_by_id(spec.buf, mark.ns, extmark, { details = true })
		local last = spec.position == "below" or spec.position == "after"
		local line = part == "text" and last and (spec.endLine or spec.line) or spec.line
		if not found[1] or found[3].invalid or found[1] ~= line - 1 then
			return true
		end
		-- The gutter colors every row it spans: it ends on the mark's last line, no further.
		if part == "gutter" and found[3].end_row ~= (spec.endLine or spec.line) - 1 then
			return true
		end
		-- Text within the line, too, belongs where the mark's columns are.
		local within = spec.position == "inline" or spec.position == "overlay" or spec.position == "after"
		if part == "text" and within and found[2] ~= text_col(spec.buf, spec, line - 1) then
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
			-- Its code re-indented (>>, a formatter) moves it with it, and wraps it anew.
			local reindented = mark.indented and mark.indented ~= indented(spec)
			if not invalid and (mark.stale or reindented or astray(mark, spec)) then
				pcall(install, id, mark.group, spec, false, true)
			end
		end
	end
end

--- Pad filled lines anew, but those hidden by a deletion: drawn over, they would show again.
-- Wrap again the marks wrapped to the windows showing their buffer, which are now wider or
-- narrower; where they are now, as edits have moved them.
function state.rewrap()
	state.prune()
	for id, mark in pairs(state.marks) do
		if mark.measure and not mark.stale and vim.api.nvim_buf_is_valid(mark.spec.buf) and measure(mark.spec) ~= mark.measure then
			local spec, invalid = current(mark)
			if not invalid then
				pcall(install, id, mark.group, spec, false, true)
			end
		end
	end
end

function state.refill()
	state.prune()
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
-- The undo state before `seq`: the one its change was made in.
local function before(entries, seq, prior)
	for i, entry in ipairs(entries) do
		local previous = i == 1 and prior or entries[i - 1].seq
		if entry.seq == seq then
			return previous
		end
		local found = entry.alt and before(entry.alt, seq, previous)
		if found then
			return found
		end
	end
end

-- How many undo states' positions a buffer keeps: before and after its last 20 reloads.
local SAVED = 40

-- Save where `buf`'s marks are, by their spans' extmarks, under its undo state: before a reload
-- (`reloading`: the state before the one the reload makes, which exists already), or after.
-- Each as { row, col, end row, end col } and whether hidden, all `restore` needs.
function state.save(buf, reloading)
	local positions = {}
	for id, mark in pairs(state.marks) do
		if mark.spec.buf == buf then
			local found = vim.api.nvim_buf_get_extmark_by_id(buf, mark.ns, mark.extmarks.span, { details = true })
			if found[1] then
				positions[id] = { found[1], found[2], found[3].end_row, found[3].end_col, found[3].invalid or nil }
			end
		end
	end
	if not next(positions) then
		return
	end
	local tree = vim.fn.undotree(buf)
	local seq = reloading and before(tree.entries, tree.seq_cur, 0) or tree.seq_cur
	if not seq then
		return
	end
	-- `at` by undo state; `order`, the states as saved, the oldest first.
	local saved = state.saved[buf] or { at = {}, order = {} }
	-- Undo states are numbered anew once its history is cleared: those saved are of another.
	for at in pairs(saved.at) do
		if at > tree.seq_last then
			saved = { at = {}, order = {} }
			break
		end
	end
	saved.at[seq] = positions
	saved.order = vim.tbl_filter(function(at)
		return at ~= seq
	end, saved.order)
	table.insert(saved.order, seq)
	-- In the order saved, as a recent reload's state before may be numbered long ago.
	while #saved.order > SAVED do
		saved.at[table.remove(saved.order, 1)] = nil
	end
	state.saved[buf] = saved
end

-- Whether `spec` lies on `needles` in `text`: its lines hold them; with columns, exactly where
-- they are, its first column where the first begins and its last where the last ends.
local function on_text(text, needles, spec)
	if not holds(text.lines, needles, spec.line) then
		return false
	elseif not (spec.columns and spec.col and spec.endCol) then
		return true
	end
	local first, last = text.raw[spec.line], text.raw[spec.line + #needles - 1]
	local tail = needles[#needles]
	return first:sub(spec.col + 1, spec.col + #needles[1]) == needles[1]
		and last:sub(spec.endCol - #tail + 1, spec.endCol) == tail
end

-- Put `buf`'s marks back where they were saved for its undo state, if they were: its text is
-- that state's again. Only a mark off the text it was placed on, and only back onto it: undo
-- states are numbered anew once the history is cleared, so one saved may be of another text.
-- A mark hidden then, or since removed, is left as it is.
function state.restore(buf)
	-- Its undo state, as changenr() has it: cheap, for every change typed (undotree() is not).
	local positions = state.saved[buf] and state.saved[buf].at[vim.api.nvim_buf_call(buf, vim.fn.changenr)]
	if not positions then
		return
	end
	local text = text_of(buf)
	for id, at in pairs(positions) do
		local mark = state.marks[id]
		if mark and mark.spec.buf == buf and not at[5] and not mark.stale then
			-- As nvim_buf_get_extmark_by_id() gives it, which `current` takes.
			local found = { at[1], at[2], { end_row = at[3], end_col = at[4] } }
			local now, saved = current(mark), current(mark, found)
			if not on_text(text, mark.anchor, now) and on_text(text, mark.anchor, saved) then
				pcall(install, id, mark.group, saved, false, true)
			end
		end
	end
end

function state.reanchor(buf)
	-- Reloaded, a buffer's changedtick can be the one its old text was cached at.
	texts[buf] = nil
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
			else
				-- On its lines, its text may still have moved along them.
				local col, endCol = spec.col, spec.endCol
				if spec.columns and spec.match then
					col, endCol = columns_of(buf, mark.anchor, found)
				end
				-- Re-indented in the file as reloaded, as when edited (see `state.sync`).
				local reindented = mark.indented and mark.indented ~= indented(spec)
				if found ~= spec.line or invalid or gone or reindented or col ~= spec.col or endCol ~= spec.endCol then
					spec.endLine = spec.endLine and spec.endLine + found - spec.line
					spec.line, spec.col, spec.endCol = found, col, endCol
					install(id, mark.group, spec, false, true)
				end
			end
		end
	end
	state.save(buf, false)
end

--- Remove the marks `ids` of `group` (of any group if nil); returns those that were there.
function state.remove(group, ids)
	state.prune()
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
	state.prune()
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
	state.prune()
	local marks = state.list(nil, {})
	for _, mark in ipairs(marks) do
		mark.stale = state.marks[mark.id].stale
	end
	return { marks = marks, watched = vim.tbl_count(state.watched), styles = vim.tbl_count(state.styles) }
end

--- Remove the marks `list` would give. Returns how many went.
function state.clear(group, filter)
	state.prune()
	local removed = 0
	for id in pairs(matching(group ~= vim.NIL and group or nil, filter)) do
		remove(id)
		removed = removed + 1
	end
	return removed
end
