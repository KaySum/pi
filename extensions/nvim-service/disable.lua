-- Keeps the plugins named in PI_NVIM_DISABLED_PLUGINS out of this instance, as lazy.nvim
-- does for a plugin whose `cond` is false. Runs before the user's configuration.
local names = vim.json.decode(vim.env.PI_NVIM_DISABLED_PLUGINS)
local disabled = {}
for _, name in ipairs(names) do disabled[name] = true end
local Config

-- lazy.nvim is not on the runtimepath yet, so wrap its configuration module once it loads.
package.preload['lazy.core.config'] = function(name)
  package.preload[name] = nil
  for i = 2, #package.loaders do
    local loader = package.loaders[i](name)
    if type(loader) == 'function' then
      Config = loader(name)
      break
    end
  end
  local setup = Config.setup
  function Config.setup(...)
    setup(...)
    -- On top of the user's own default `cond`, if any.
    local cond = Config.options.defaults.cond
    Config.options.defaults.cond = function(plugin)
      if disabled[plugin.name] then return false end
      if type(cond) == 'function' then return cond(plugin) end
      return cond ~= false
    end
  end
  return Config
end

-- Why listed plugins are still enabled, one per line, for Pi to warn about.
function _G.__pi_nvim_disable_problems()
  if not (Config and Config.spec) then return 'lazy.nvim was not set up, so no plugin was disabled' end
  local problems = {}
  for _, name in ipairs(names) do
    if Config.plugins[name] then
      problems[#problems + 1] = name .. ' is still enabled: its spec sets its own `cond`'
    elseif not Config.spec.disabled[name] then
      problems[#problems + 1] = name .. ' is not a lazy.nvim plugin'
    end
  end
  return table.concat(problems, '\n')
end
