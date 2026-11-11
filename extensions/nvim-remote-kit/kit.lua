-- Installs `remote.kit`, once for each attachment: what the extensions working in the user's
-- Neovim share, so that each does it the same, hardened way. It runs through nvim-remote, with
-- `remote` in scope; api.ts installs it before any module that uses it.

if remote.kit then
	return
end
local kit = {}
remote.kit = kit

--- What keeps the user busy, so that nothing should move their cursor now: their mode, unless
--- normal or terminal, or "cmdwin" in the command-line window (where no other window can
--- change). Nil while they are free.
function kit.busy()
	local mode = vim.api.nvim_get_mode().mode
	if not (mode == "n" or mode == "nt" or mode == "t") then
		return mode
	elseif vim.fn.getcmdwintype() ~= "" then
		return "cmdwin"
	end
end

--- Say the first of `texts` (one, or a list from the longest) that fits where messages go
--- (`v:echospace`, less with 'ruler' and 'showcmd'), else the last cut to fit: a longer one
--- would stop the editor at "Press ENTER". `level`: a `vim.log.levels`, INFO if not given.
function kit.say(texts, level)
	texts = type(texts) == "table" and texts or { texts }
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
		vim.notify(text, level or vim.log.levels.INFO)
	end
end

--- Whether `win` is a window of the user's own work: no float, showing a file's buffer (not
--- Pi's terminal, help, a list…).
function kit.shows_file(win)
	return win ~= 0
		and vim.api.nvim_win_is_valid(win)
		and vim.api.nvim_win_get_config(win).relative == ""
		and vim.bo[vim.api.nvim_win_get_buf(win)].buftype == ""
end

--- This tab's windows, the one the user is in first, then the one they came from.
function kit.windows()
	local wins = { vim.api.nvim_get_current_win(), vim.fn.win_getid(vim.fn.winnr("#")) }
	vim.list_extend(wins, vim.api.nvim_tabpage_list_wins(0))
	return vim.tbl_filter(function(win)
		return win ~= 0 and vim.api.nvim_win_is_valid(win)
	end, wins)
end

--- The user's window: the one they are in unless it is Pi's terminal (or another like it, see
--- `shows_file`), else the one they came from, else any of this tab showing a file. Nil if none.
function kit.yours()
	return vim.iter(kit.windows()):find(kit.shows_file)
end

--- Whether a buffer is the file at `path`, as Neovim tells files apart: by device and inode while
--- it is on disk, so links, hard or symbolic, are one file; and by name as Neovim matches one
--- ('fileignorecase', its own case folding). Returns a test of a buffer number, adding none.
function kit.file(path)
	-- bufadd() takes the name literally, as bufnr() does not (a pattern); once bufexists() has
	-- found one, so that none is added.
	local named = vim.fn.bufexists(path) == 1 and vim.fn.bufadd(path) or nil
	local stat = vim.uv.fs_stat(path)
	return function(buf)
		if buf == named then
			return true
		end
		local name = vim.api.nvim_buf_get_name(buf)
		local other = stat and name ~= "" and vim.uv.fs_stat(name)
		return other and other.dev == stat.dev and other.ino == stat.ino or false
	end
end

--- Load `buf`, as the user's own would be; `existed`: it was in the buffer list before. What was
--- done for it, to undo (see `undo`) if it is not used after all: "added", "loaded", or nil.
function kit.load(buf, existed)
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

--- Undo what `load` did for `buf`, not to leave it loaded (a swap file and all) for a file the
--- user did not open.
function kit.undo(buf, done)
	if done and vim.api.nvim_buf_is_valid(buf) then
		vim.api.nvim_buf_delete(buf, { force = true, unload = done == "loaded" })
	end
end

--- The buffer of the file at `path`, loaded, and what was done for it (see `load`). Fails for
--- what is no file to read: missing, a directory or device, unreadable, or made a buffer of
--- another kind.
function kit.open(path)
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
	local done = kit.load(buf, existed)
	-- The user's autocommands, as it was read, may have made it a buffer of another kind.
	if vim.bo[buf].buftype ~= "" then
		kit.undo(buf, done)
		error(("not a file: %s"):format(path), 0)
	end
	return buf, done
end

-- Whether a FileChangedShell autocommand of the user's applies to `buf`: one of its own, or one
-- whose pattern Neovim matches to its file. Neovim's own matching decides (short and full
-- names, 'fileignorecase'): each pattern is given to a probe of ours, fired for `buf` alone.
local function handled(buf)
	local applies = false
	local probe = vim.api.nvim_create_augroup("nvim-remote-kit-probe", { clear = true })
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

--- Run `fn` where Neovim may find `buf`'s file changed on disk and ask what to do at a prompt,
--- which would hold the call until the user answers: unless they handle it themselves (a
--- FileChangedShell that applies to it), it is reloaded as 'autoread' would, else left, and they
--- are told after.
function kit.guarded(buf, fn)
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
						kit.say({ ("%s changed on disk%s: :e! loads it"):format(name, how), ("%s changed on disk%s"):format(name, how) }, vim.log.levels.WARN)
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
