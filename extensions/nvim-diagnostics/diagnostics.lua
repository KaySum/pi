-- Arguments are JSON data. Nothing in a path/message is executed as Lua or Ex.
return function(json)
  local args = vim.json.decode(json)
  local state = assert(_G.pi_nvim_diagnostics, "Missing diagnostics bootstrap")
  local function array() return vim.json.decode("[]") end
  local out = { status = "snapshot", complete = false, diagnostics = array(), providers = array(),
    notices = array(), counts = { error = 0, warning = 0, information = 0, hint = 0 }, omitted = 0 }
  local function text(value, limit)
    if value == nil then return nil end
    local s = tostring(value)
    limit = limit or 1000
    if #s <= limit then return s end
    out.textTruncated = true
    while limit > 0 do
      local byte = s:byte(limit + 1)
      if not byte or byte < 128 or byte >= 192 then break end
      limit = limit - 1
    end
    return s:sub(1, limit) .. " [truncated]"
  end
  local active, requests = true, {}
  local ok, err = pcall(function()
    local start = vim.uv.hrtime() / 1e6
    local deadline = start + args.timeout_ms
    local file = assert(io.open(args.file, "rb"))
    local contents = file:read(1024 * 1024 + 1) or ""
    file:close()
    if #contents > 1024 * 1024 then error("File exceeds 1 MiB limit") end
    if vim.fn.sha256(contents) ~= args.fingerprint then error("File changed before loading; retry") end
    local oldbuf = vim.fn.bufnr(args.file)
    local baseline = vim.deepcopy(state.updates[oldbuf] or {})
    vim.cmd("keepalt edit " .. vim.fn.fnameescape(args.file))
    local b = vim.api.nvim_get_current_buf()
    if vim.bo[b].modified then error("A plugin modified the headless buffer; refusing to report it as disk contents") end
    if vim.bo[b].filetype == "" then vim.cmd("filetype detect") end
    -- BufReadPost edits can have 'modified' reset by Neovim after the callback.
    -- Verify actual loaded text, not just that flag or a post-load changedtick.
    local expected = contents
    local encoding = vim.bo[b].fileencoding
    if encoding ~= "" and encoding ~= "utf-8" then expected = assert(vim.iconv(expected, encoding, "utf-8")) end
    if expected:sub(1, 3) == "\239\187\191" then expected = expected:sub(4) end
    if vim.bo[b].fileformat == "dos" then expected = expected:gsub("\r\n", "\n")
    elseif vim.bo[b].fileformat == "mac" then expected = expected:gsub("\r", "\n") end
    expected = expected:gsub("\n$", "")
    if table.concat(vim.api.nvim_buf_get_lines(b, 0, -1, false), "\n") ~= expected then
      error("A plugin modified the loaded text or decoding differs from disk; refusing the snapshot")
    end
    out.filetype = vim.bo[b].filetype
    local tick = vim.api.nvim_buf_get_changedtick(b)
    local function updated(ns) return ((state.updates[b] or {})[ns] or 0) > (baseline[ns] or 0) end
    local ns_client, tracked, lint_records = {}, {}, {}
    local used_namespaces = {}
    local function provider(record)
      if #out.providers >= 50 then out.providersTruncated = true; return false end
      out.providers[#out.providers + 1] = record
      return true
    end

    local have_lint, lint = pcall(require, "lint")
    if have_lint and type(lint.try_lint) == "function" and type(lint.get_namespace) == "function" then
      -- Prevent automatic/debounced callbacks from cancelling or duplicating the
      -- explicit checks, including when the next file becomes the current buffer.
      if not state.lint_try then
        state.lint_try = lint.try_lint
        lint.try_lint = function() end
        pcall(vim.api.nvim_del_augroup_by_name, "nvim-lint")
      end
      local by_ft = lint.linters_by_ft or {}
      local names = vim.deepcopy(by_ft[vim.bo[b].filetype] or {})
      if not by_ft[vim.bo[b].filetype] then
        for ft in vim.bo[b].filetype:gmatch("[^.]+") do vim.list_extend(names, by_ft[ft] or {}) end
      end
      if #names == 0 then vim.list_extend(names, by_ft._ or {}) end
      vim.list_extend(names, by_ft["*"] or {})
      local seen = {}
      for _, name in ipairs(names) do
        if not seen[name] and #lint_records < 30 then
          seen[name] = true
          local record = { kind = "lint", name = text(name, 200), status = "requested" }
          local ns = lint.get_namespace(name)
          used_namespaces[ns] = true
          lint_records[#lint_records + 1] = { record = record, ns = ns }
          provider(record)
          local notices_before = #state.notices
          local ran, failure = pcall(state.lint_try, { name }, { filter = function(definition)
            record.processName = definition.name or name
            if definition.condition then
              local matches = definition.condition({ filename = args.file, dirname = vim.fs.dirname(args.file) })
              if not matches then record.status = "skipped_condition"; return false end
            end
            return true
          end })
          if not ran then record.status = "error"; record.error = text(failure) end
          if #state.notices > notices_before then record.warning = text(state.notices[#state.notices]) end
        end
      end
      if #names == 0 then provider({ kind = "lint", name = "nvim-lint", status = "not_configured_for_file" }) end
    else
      provider({ kind = "lint", name = "nvim-lint", status = "unavailable" })
    end

    local function byte_column(line, character, encoding)
      local s = vim.api.nvim_buf_get_lines(b, line, line + 1, false)[1] or ""
      local valid, column = pcall(vim.str_byteindex, s, encoding, character, false)
      return valid and column or #s
    end
    local function step()
      for _, client in ipairs(vim.lsp.get_clients({ bufnr = b })) do
        local record = tracked[client.id]
        if not record and #out.providers < 50 then
          record = { kind = "lsp", name = text(client.name, 200), status = "initializing" }
          tracked[client.id] = record
          provider(record)
          local push_ns = vim.lsp.diagnostic.get_namespace(client.id, false)
          record.pushNamespace = push_ns
          ns_client[push_ns] = client.id
          used_namespaces[push_ns] = true
        end
        if record and client.initialized and not record.started then
          record.started = true
          record.status = "attached_no_update_observed"
          if client:supports_method("textDocument/diagnostic", b) then
            record.status = "pull_pending"
            local caps = client.server_capabilities.diagnosticProvider
            local identifier = type(caps) == "table" and caps.identifier or nil
            local ns = vim.lsp.diagnostic.get_namespace(client.id, true, identifier)
            ns_client[ns] = client.id
            used_namespaces[ns] = true
            record.pullNamespace = ns
            local sent, id = client:request("textDocument/diagnostic", {
              textDocument = { uri = vim.uri_from_bufnr(b) }, identifier = identifier,
            }, function(failure, response)
              if not active then return end
              if failure then record.status = "error"; record.error = text(failure.message or failure); return end
              if not response or response.kind ~= "full" then record.status = "pull_unchanged_or_unknown"; return end
              record.status = "pull_responded"
              local diagnostics = {}
              for _, d in ipairs(response.items or {}) do
                if d.range and d.range.start and d.range["end"] then
                  diagnostics[#diagnostics + 1] = {
                    lnum = d.range.start.line,
                    col = byte_column(d.range.start.line, d.range.start.character, client.offset_encoding),
                    end_lnum = d.range["end"].line,
                    end_col = byte_column(d.range["end"].line, d.range["end"].character, client.offset_encoding),
                    severity = d.severity or 1, message = d.message, source = d.source, code = d.code,
                  }
                end
              end
              -- Same namespace as Neovim's automatic pull path, not a second copy.
              vim.diagnostic.set(ns, b, diagnostics)
            end, b)
            if sent then requests[#requests + 1] = { client, id }
            else record.status = "error"; record.error = "Pull request could not be sent" end
          end
        end
      end
    end
    step()
    local remaining = math.max(0, math.floor(deadline - vim.uv.hrtime() / 1e6))
    vim.wait(remaining, function() step(); return false end, 20)
    if vim.bo[b].modified or vim.api.nvim_buf_get_changedtick(b) ~= tick then
      error("Headless buffer changed during check; diagnostics are not a verified disk snapshot")
    end
    for _, record in pairs(tracked) do
      if record.status == "initializing" or record.status == "pull_pending" then out.status = "timed_out" end
      if record.status == "attached_no_update_observed" and updated(record.pushNamespace) then record.status = "push_update_observed" end
      record.started = nil
    end
    local running = {}
    if have_lint and type(lint.get_running) == "function" then
      for _, name in ipairs(lint.get_running(b)) do running[name] = true end
    end
    for _, item in ipairs(lint_records) do
      local record = item.record
      if record.status == "requested" then
        if running[record.processName or record.name] then record.status = "pending"; out.status = "timed_out"
        elseif updated(item.ns) then record.status = "update_observed"
        else record.status = "no_update_observed" end
      end
      record.processName = nil
    end
    local wanted = {}
    for _, severity in ipairs(args.severity) do wanted[severity] = true end
    local severities = { "error", "warning", "information", "hint" }
    local all = vim.diagnostic.get(b)
    table.sort(all, function(a, d)
      if a.lnum ~= d.lnum then return a.lnum < d.lnum end
      if a.col ~= d.col then return a.col < d.col end
      if (a.severity or 1) ~= (d.severity or 1) then return (a.severity or 1) < (d.severity or 1) end
      if (a.namespace or 0) ~= (d.namespace or 0) then return (a.namespace or 0) < (d.namespace or 0) end
      return a.message < d.message
    end)
    local namespaces, seen = vim.diagnostic.get_namespaces(), {}
    for _, d in ipairs(all) do
      local severity = severities[d.severity or 1] or "error"
      local ns = d.namespace or 0
      local nsname = (namespaces[ns] or {}).name or tostring(ns)
      local code = d.code or vim.tbl_get(d, "user_data", "lsp", "code")
      local key = vim.json.encode({ ns_client[ns] and ("client:" .. ns_client[ns]) or ("namespace:" .. ns),
        d.lnum, d.col, d.end_lnum, d.end_col, severity, d.message, d.source or "", tostring(code or "") })
      if not seen[key] then
        seen[key] = true
        out.counts[severity] = out.counts[severity] + 1
        if wanted[severity] then
          if #out.diagnostics < args.limit then
            out.diagnostics[#out.diagnostics + 1] = {
              line = d.lnum + 1, column = d.col + 1, endLine = (d.end_lnum or d.lnum) + 1,
              endColumn = (d.end_col or d.col) + 1, severity = severity,
              message = text(d.message), source = text(d.source, 200), code = text(code, 200),
              namespace = text(nsname, 200), namespaceId = ns,
              freshness = updated(ns) and "update_observed" or "cached_or_unknown",
            }
          else out.omitted = out.omitted + 1 end
        end
      end
    end
    for ns in pairs(state.updates[b] or {}) do
      if not used_namespaces[ns] then
        provider({ kind = "diagnostic_namespace", name = text((namespaces[ns] or {}).name or ns, 200),
          status = updated(ns) and "update_observed" or "cached_or_unknown" })
      end
    end
    table.sort(out.providers, function(a, d) return a.kind .. a.name < d.kind .. d.name end)
    out.elapsed_ms = math.floor(vim.uv.hrtime() / 1e6 - start)
  end)
  active = false
  for _, request in ipairs(requests) do pcall(request[1].cancel_request, request[1], request[2]) end
  for _, notice in ipairs(state.notices) do out.notices[#out.notices + 1] = text(notice) end
  if not ok then out.status = "error"; out.error = text(err) end
  return vim.json.encode(out)
end
