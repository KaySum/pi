-- Runs in the Neovim whose :terminal hosts Pi. Neovim swallows a child's notification
-- escape, so post it to the outer terminal ourselves, then show Pi when focus returns.
return function(opts)
  vim.api.nvim_ui_send(opts.osc)
  local buf = vim.iter(vim.api.nvim_list_bufs()):find(function(b)
    return vim.tbl_contains(opts.pids, vim.b[b].terminal_job_pid)
  end)
  if not buf then return end
  local ok, terminals = pcall(require, 'sidekick.cli.terminal')
  local sidekick = ok and vim.iter(vim.tbl_values(terminals.terminals)):find(function(t) return t.buf == buf end)
  vim.api.nvim_create_autocmd('FocusGained', {
    group = vim.api.nvim_create_augroup('pi_notify_' .. buf, {}),
    once = true,
    callback = function()
      if not vim.api.nvim_buf_is_valid(buf) then return end
      if sidekick then return sidekick:focus() end
      local win = vim.fn.win_findbuf(buf)[1]
      if win then vim.api.nvim_set_current_win(win) else vim.api.nvim_set_current_buf(buf) end
      vim.cmd.startinsert()
    end,
  })
end
