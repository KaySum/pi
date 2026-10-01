-- Runs via --cmd before the user's init. All changes are private to this child.
if vim.fn.has("nvim-0.11") ~= 1 then
  error("nvim_diagnostics requires Neovim 0.11+")
end
local state = { notices = {}, updates = {} }
_G.pi_nvim_diagnostics = state
local seen_notices = {}
local function notice(message)
  if #state.notices >= 30 then return end
  local s, limit = tostring(message), 1000
  if #s > limit then
    while limit > 0 and s:byte(limit + 1) >= 128 and s:byte(limit + 1) < 192 do limit = limit - 1 end
    s = s:sub(1, limit) .. " [truncated]"
  end
  if seen_notices[s] then return end
  seen_notices[s] = true
  state.notices[#state.notices + 1] = s
end
state.notice = notice
vim.opt.swapfile = false
vim.opt.undofile = false
vim.opt.shadafile = "NONE"
vim.opt.exrc = false
vim.opt.autoread = true
vim.g.autoformat = false
vim.g.lazyvim_check_order = false

-- Both LSP (vim.system) and nvim-lint use this spawn path, normally detached.
-- Keep their children in Neovim's supervisor-owned POSIX process group instead.
local spawn = vim.uv.spawn
vim.uv.spawn = function(command, options, callback)
  local owned = {}
  for key, value in pairs(options or {}) do owned[key] = value end
  owned.detached = false
  return spawn(command, owned, callback)
end

-- A shared/network server is not owned by this call and must not receive shutdown.
vim.lsp.rpc.connect = function()
  error("nvim_diagnostics does not support shared/TCP LSP servers; configure a spawned stdio server")
end

-- Observe publication, including empty updates. An update is NOT a completeness signal.
local diagnostic_set = vim.diagnostic.set
vim.diagnostic.set = function(namespace, bufnr, diagnostics, opts)
  bufnr = bufnr == 0 and vim.api.nvim_get_current_buf() or bufnr
  state.updates[bufnr] = state.updates[bufnr] or {}
  state.updates[bufnr][namespace] = (state.updates[bufnr][namespace] or 0) + 1
  return diagnostic_set(namespace, bufnr, diagnostics, opts)
end

-- Known plugin guards only. Arbitrary user config can still have side effects.
-- Wrapping require lets us patch setup BEFORE the first caller invokes it, without
-- forcing plugins to load or changing any files in the user's configuration.
local original_require = require
local patched = {}
_G.require = function(name)
  local module = original_require(name)
  if patched[name] or type(module) ~= "table" then return module end
  patched[name] = true
  if name == "lazy" and type(module.setup) == "function" then
    local setup = module.setup
    module.setup = function(spec, opts)
      if type(spec) == "table" and spec.spec then
        opts = spec
      else
        opts = opts or {}
        opts.spec = spec
      end
      opts.checker = vim.tbl_extend("force", opts.checker or {}, { enabled = false })
      opts.install = vim.tbl_extend("force", opts.install or {}, { missing = false })
      opts.change_detection = { enabled = false, notify = false }
      return setup(opts)
    end
  elseif name == "mason-lspconfig" and type(module.setup) == "function" then
    local setup = module.setup
    module.setup = function(opts)
      opts = vim.tbl_extend("force", opts or {}, { ensure_installed = {}, automatic_installation = false })
      return setup(opts)
    end
  elseif name == "mason-registry" then
    for _, method in ipairs({ "refresh", "refresh_system", "update", "update_system" }) do
      if module[method] then
        module[method] = function(callback)
          if callback then callback(false, {}) end
          return false, {}
        end
      end
    end
  elseif name == "mason-core.package" then
    for _, method in ipairs({ "install", "uninstall" }) do
      if module[method] then
        module[method] = function(_self, _opts, callback)
          local message = "Mason " .. method .. " disabled in nvim_diagnostics; install tools in your normal editor"
          notice(message)
          if type(callback) == "function" then callback(false, message) end
          -- LazyVim's automatic ensure-installed loop ignores this return value.
          -- Do not throw: that would abort unrelated installed-provider setup.
          return nil
        end
      end
    end
  end
  return module
end

-- Capture instead of displaying notifications in this headless process. Calling
-- the default ERROR renderer inside a nested RPC wait can fail the entire RPC,
-- even when the provider error was handled. The agent still gets these notices.
vim.notify = function(message, level, _opts)
  if (level or vim.log.levels.INFO) >= vim.log.levels.WARN then
    notice(((level or 0) >= vim.log.levels.ERROR and "ERROR: " or "WARN: ") .. tostring(message))
  end
end

function state.shutdown()
  for _, client in ipairs(vim.lsp.get_clients()) do pcall(client.stop, client, false) end
  -- Allow a brief protocol shutdown; the supervisor bounds the entire teardown.
  -- No save, no BufWritePost. Hung callbacks are handled outside Neovim.
  vim.defer_fn(function() vim.cmd("qa!") end, 100)
  return true
end
