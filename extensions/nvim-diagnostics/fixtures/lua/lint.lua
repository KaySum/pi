-- Minimal deterministic nvim-lint API double; no personal plugins/config loaded.
local M = { linters = {}, linters_by_ft = {} }
local namespaces, running = {}, {}
function M.get_namespace(name)
  namespaces[name] = namespaces[name] or vim.api.nvim_create_namespace("lint-fixture:" .. name)
  return namespaces[name]
end
function M.get_running(bufnr)
  local names = {}
  for name in pairs(running[bufnr] or {}) do names[#names + 1] = name end
  return names
end
function M.try_lint(names, opts)
  local b = vim.api.nvim_get_current_buf()
  for _, name in ipairs(names) do
    local definition = assert(M.linters[name], "Missing fixture linter: " .. name)
    definition.name = name
    if not opts.filter or opts.filter(definition) then
      local stdout, handle = assert(vim.uv.new_pipe(false)), nil
      local args = vim.list_extend(vim.deepcopy(definition.args or {}), { vim.api.nvim_buf_get_name(b) })
      local output = ""
      local process_done, output_done, code = false, false, nil
      local function finish()
        if not process_done or not output_done then return end
        vim.schedule(function()
          running[b][name] = nil
          if code ~= 0 then vim.notify("Fixture linter failed: " .. tostring(code), vim.log.levels.ERROR)
          else vim.diagnostic.set(M.get_namespace(name), b, definition.parser(output, b)) end
        end)
      end
      -- Deliberately request detachment; the bootstrap must override it.
      handle = assert(vim.uv.spawn(definition.cmd, { args = args, detached = true, stdio = { nil, stdout, nil } }, function(exit_code)
        code, process_done = exit_code, true
        handle:close()
        finish()
      end))
      running[b] = running[b] or {}
      running[b][name] = true
      stdout:read_start(function(err, chunk)
        assert(not err, err)
        if chunk then output = output .. chunk
        else stdout:close(); output_done = true; finish() end
      end)
    end
  end
end
return M
