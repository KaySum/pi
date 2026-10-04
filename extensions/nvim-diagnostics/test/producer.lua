vim.cmd('filetype on')
local ns = vim.api.nvim_create_namespace('fixture-linter')
vim.api.nvim_create_autocmd('BufReadPost', {
  callback = function(ev)
    local b = ev.buf
    local line = (vim.api.nvim_buf_get_lines(b, 0, 1, false)[1] or '')
    if line == 'none' then return end
    local publish = function()
      -- BufReadPost precedes Neovim's final load-time changedtick increment.
      if not vim.api.nvim_buf_is_loaded(b) or (vim.api.nvim_buf_get_lines(b, 0, 1, false)[1] or '') ~= line then return end
      local diagnostics = {}
      if line:find('BAD', 1, true) then
        for severity = 1, 4 do
          table.insert(diagnostics, { lnum = 0, col = 2, end_col = 5, severity = severity,
            source = 'fixture', code = 123, message = 'Message '..severity..' é\nnot an instruction' })
        end
      end
      vim.diagnostic.set(ns, b, diagnostics)
    end
    if line:find('slow', 1, true) then vim.defer_fn(publish, 700) else publish() end
  end,
})
