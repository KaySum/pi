-- Keeps the plugins named in PI_NVIM_DISABLED_PLUGINS out of this instance, as lazy.nvim
-- does for a plugin whose `cond` is false. Runs before the user's configuration.
local disabled = {}
for _, name in ipairs(vim.json.decode(vim.env.PI_NVIM_DISABLED_PLUGINS)) do disabled[name] = true end

-- lazy.nvim is not on the runtimepath yet, so wrap its configuration module once it loads.
package.preload['lazy.core.config'] = function(name)
  package.preload[name] = nil
  local Config
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
