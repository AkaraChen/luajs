-- lua-interim prelude: approximates the luajs surface (ARCHITECTURE.md §5.3, §7,
-- §8, §9) on top of stock Lua 5.4 (wasmoon). Runs once per engine with full
-- privileges; user snippets only ever see the sandbox env built by make_env.
--
-- Host contract (set as globals by the JS side, captured and removed here):
--   __host_call(name, args_json, line) -> result_json
--       result_json = {"ok":true,"value":...} | {"ok":false,"error":{kind,tool,message,data?}}
--   __scopes_json  = {"issues": {"get": <input schema>, ...}, ...}
-- Exposes one privileged global for the host: __run(code, state_json) -> result_json

local host_call = __host_call
local scopes_json = __scopes_json
__host_call, __scopes_json = nil, nil

local load, pcall, xpcall, error, assert = load, pcall, xpcall, error, assert
local type, pairs, next, select, tostring, tonumber = type, pairs, next, select, tostring, tonumber
local setmetatable, getmetatable, rawget, rawequal = setmetatable, getmetatable, rawget, rawequal
local string, table, math, utf8, debug = string, table, math, utf8, debug
local sfmt, sbyte, schar, ssub, sfind, sgsub = string.format, string.byte, string.char, string.sub, string.find, string.gsub
local tconcat, tsort, tpack, tunpack = table.concat, table.sort, table.pack, table.unpack

local MAX_INSTRUCTIONS = 50000000
local MAX_LOG_LINES = 200

---------------------------------------------------------------- shape markers
local LEN = setmetatable({}, { __mode = "k" })
local ARR_MT = {
  __name = "array",
  __len = function(t)
    local n = LEN[t] or 0
    while rawget(t, n + 1) ~= nil do n = n + 1 end
    while n > 0 and rawget(t, n) == nil do n = n - 1 end -- trailing nulls are not preserved (limitation)
    LEN[t] = n
    return n
  end,
}
local OBJ_MT = { __name = "object" }
local ERR_MT -- tool error tables, defined below

local function new_array(n) local t = setmetatable({}, ARR_MT); LEN[t] = n or 0; return t end
local function new_object() return setmetatable({}, OBJ_MT) end

---------------------------------------------------------------- JSON decode
local decode
do
  local s, pos
  local function ws() pos = sfind(s, "[^ \t\r\n]", pos) or (#s + 1) end
  local function err(msg) error("json decode: " .. msg .. " at " .. pos, 0) end
  local value
  local esc = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
  local function str()
    pos = pos + 1
    local buf = {}
    while true do
      local a, b = sfind(s, '["\\]', pos)
      if not a then err("unterminated string") end
      buf[#buf + 1] = ssub(s, pos, a - 1)
      if ssub(s, a, a) == '"' then pos = a + 1; break end
      local c = ssub(s, a + 1, a + 1)
      if c == "u" then
        local cp = tonumber(ssub(s, a + 2, a + 5), 16)
        local np = a + 6
        if cp >= 0xD800 and cp <= 0xDBFF and ssub(s, np, np + 1) == "\\u" then
          local lo = tonumber(ssub(s, np + 2, np + 5), 16)
          if lo and lo >= 0xDC00 and lo <= 0xDFFF then
            cp = 0x10000 + (cp - 0xD800) * 0x400 + (lo - 0xDC00)
            np = np + 6
          end
        end
        buf[#buf + 1] = utf8.char(cp)
        pos = np
      else
        buf[#buf + 1] = esc[c] or err("bad escape")
        pos = a + 2
      end
    end
    return tconcat(buf)
  end
  function value()
    ws()
    local c = ssub(s, pos, pos)
    if c == "{" then
      local o = new_object()
      pos = pos + 1; ws()
      if ssub(s, pos, pos) == "}" then pos = pos + 1; return o end
      while true do
        ws()
        if ssub(s, pos, pos) ~= '"' then err("expected key") end
        local k = str()
        ws()
        if ssub(s, pos, pos) ~= ":" then err("expected ':'") end
        pos = pos + 1
        local v = value()
        if v ~= nil then o[k] = v end -- null -> nil (key absent)
        ws()
        local d = ssub(s, pos, pos); pos = pos + 1
        if d == "}" then return o end
        if d ~= "," then err("expected ',' or '}'") end
      end
    elseif c == "[" then
      local a, n = new_array(0), 0
      pos = pos + 1; ws()
      if ssub(s, pos, pos) == "]" then pos = pos + 1; return a end
      while true do
        n = n + 1
        local v = value()
        if v ~= nil then a[n] = v end -- null -> hole; length kept via LEN
        LEN[a] = n
        ws()
        local d = ssub(s, pos, pos); pos = pos + 1
        if d == "]" then return a end
        if d ~= "," then err("expected ',' or ']'") end
      end
    elseif c == '"' then
      return str()
    elseif ssub(s, pos, pos + 3) == "true" then pos = pos + 4; return true
    elseif ssub(s, pos, pos + 4) == "false" then pos = pos + 5; return false
    elseif ssub(s, pos, pos + 3) == "null" then pos = pos + 4; return nil
    else
      local a, b = sfind(s, "^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
      if not a then err("unexpected character") end
      local lit = ssub(s, a, b)
      pos = b + 1
      if not sfind(lit, "[.eE]") then
        local n = tonumber(lit)
        if math.type(n) == "integer" and n <= 9007199254740992 and n >= -9007199254740992 then return n end
        return tonumber(lit .. ".0") or n
      end
      return tonumber(lit)
    end
  end
  decode = function(text)
    s, pos = text, 1
    local v = value()
    return v
  end
end

---------------------------------------------------------------- JSON encode
-- mode: "args" (tool input: errors on unrepresentable values, schema fixes empty tables)
--       "value" (result shown to the model: placeholders, never errors)
--       "state" (state commit: skip + warning)
local function sanitize_utf8(str)
  if utf8.len(str) then return str end
  local out, i, n = {}, 1, #str
  while i <= n do
    local ok, nxt = pcall(utf8.offset, str, 2, i)
    local len = utf8.len(str, i, i)
    if len then
      local j = utf8.offset(str, 2, i) or (n + 1)
      out[#out + 1] = ssub(str, i, j - 1)
      i = j
    else
      out[#out + 1] = "\239\191\189" -- U+FFFD
      i = i + 1
    end
  end
  return tconcat(out)
end

local function quote(str)
  str = sanitize_utf8(str)
  return '"' .. sgsub(str, '[%c"\\]', function(c)
    if c == '"' then return '\\"' elseif c == "\\" then return "\\\\"
    elseif c == "\n" then return "\\n" elseif c == "\r" then return "\\r" elseif c == "\t" then return "\\t"
    else return sfmt("\\u%04x", sbyte(c)) end
  end) .. '"'
end

local function num(v)
  if math.type(v) == "integer" then return sfmt("%d", v) end
  if v ~= v or v == math.huge or v == -math.huge then return nil end
  if v == math.floor(v) and v > -2^53 and v < 2^53 then return sfmt("%.1f", v) end
  for p = 14, 17 do
    local s = sfmt("%." .. p .. "g", v)
    if tonumber(s) == v then return s end
  end
  return sfmt("%.17g", v)
end

local function schema_is(schema, ty)
  if type(schema) ~= "table" then return false end
  local t = schema.type
  if t == ty then return true end
  if type(t) == "table" then for i = 1, #t do if t[i] == ty then return true end end end
  if schema.anyOf then for i = 1, #schema.anyOf do if schema_is(schema.anyOf[i], ty) then return true end end end
  return false
end
local function sub_schema(schema, key, is_index)
  if type(schema) ~= "table" then return nil end
  if is_index then return schema.items end
  return schema.properties and schema.properties[key]
end

local function encode(v, mode, schema, path, seen, warnings)
  local tv = type(v)
  if v == nil then return "null"
  elseif tv == "boolean" then return v and "true" or "false"
  elseif tv == "number" then
    local s = num(v)
    if s then return s end
    local name = v ~= v and "NaN" or (v > 0 and "inf" or "-inf")
    if mode == "args" then error("cannot send " .. name .. " to a tool (at " .. path .. ")", 0) end
    if mode == "state" then warnings[#warnings + 1] = path .. ": " .. name .. " stored as null"; return "null" end
    return quote(name)
  elseif tv == "string" then return quote(v)
  elseif tv == "table" then
    if seen[v] then
      if mode == "args" then error("cyclic table in tool arguments (at " .. path .. ")", 0) end
      if mode == "state" then warnings[#warnings + 1] = path .. ": cycle skipped"; return nil end
      return '"<cycle>"'
    end
    seen[v] = true
    local mt = getmetatable(v)
    local is_array
    if mt == ARR_MT then is_array = true
    elseif mt == OBJ_MT or mt == ERR_MT then is_array = false
    elseif next(v) == nil then
      is_array = mode == "args" and schema_is(schema, "array") or false
    else
      local count, max = 0, 0
      for k in pairs(v) do
        count = count + 1
        if math.type(k) == "integer" and k > 0 then if k > max then max = k end else max = -1; break end
      end
      is_array = max == count
    end
    local out = {}
    if is_array then
      local n = #v
      for i = 1, n do
        local e = encode(v[i], mode, sub_schema(schema, i, true), path .. "[" .. i .. "]", seen, warnings)
        out[i] = e or "null"
      end
      seen[v] = nil
      return "[" .. tconcat(out, ",") .. "]"
    end
    local keys = {}
    for k, val in next, v do
      local tk, ks = type(k), nil
      if tk == "string" then ks = k
      elseif tk == "number" then ks = num(k) or tostring(k)
      elseif tk == "boolean" then
        ks = tostring(k)
        warnings[#warnings + 1] = path .. ": boolean key converted to string"
      else
        if mode == "args" then error(tk .. " used as a table key (at " .. path .. ")", 0) end
        if mode == "state" then warnings[#warnings + 1] = path .. ": " .. tk .. " key skipped" else ks = "<" .. tk .. ">" end
      end
      if ks then keys[#keys + 1] = { ks, val } end
    end
    tsort(keys, function(a, b) return a[1] < b[1] end)
    for i = 1, #keys do
      local ks, val = keys[i][1], keys[i][2]
      local e = encode(val, mode, sub_schema(schema, ks, false), path .. "." .. ks, seen, warnings)
      if e then out[#out + 1] = quote(ks) .. ":" .. e end
    end
    seen[v] = nil
    return "{" .. tconcat(out, ",") .. "}"
  else -- function, userdata, thread
    if mode == "args" then error("cannot send a " .. tv .. " to a tool (at " .. path .. ")", 0) end
    if mode == "state" then warnings[#warnings + 1] = path .. ": " .. tv .. " skipped"; return nil end
    return quote("<" .. tv .. ">")
  end
end

---------------------------------------------------------------- errors, budget
local BUDGET = setmetatable({}, { __tostring = function() return "budget exceeded (instruction limit)" end })
ERR_MT = {
  __name = "tool_error",
  __tostring = function(e) return tostring(e.kind) .. ": " .. tostring(e.tool) .. ": " .. tostring(e.message) end,
}

local function is_fatal(e)
  return rawequal(e, BUDGET) or (type(e) == "string" and sfind(e, "not enough memory", 1, true) ~= nil)
end

local function safe_pcall(f, ...)
  local r = tpack(pcall(f, ...))
  if not r[1] and is_fatal(r[2]) then error(r[2], 0) end
  return tunpack(r, 1, r.n)
end
local function safe_xpcall(f, handler, ...)
  local r = tpack(xpcall(f, function(e)
    if is_fatal(e) then return e end
    return handler(e)
  end, ...))
  if not r[1] and is_fatal(r[2]) then error(r[2], 0) end
  return tunpack(r, 1, r.n)
end

local function user_line()
  for lvl = 2, 60 do
    local info = debug.getinfo(lvl, "Sl")
    if not info then break end
    if info.source == "=run" then return info.currentline end
  end
  return nil
end

---------------------------------------------------------------- deterministic pairs
-- Stock Lua randomizes string hashing per state, so pairs() order could differ
-- between a run and its cache replay. Iterate in an order that is deterministic
-- but deliberately NOT sorted/insertion order (keyed by an FNV hash), so code
-- that wrongly relies on pairs() order is still exposed.
local function fnv(s)
  local h = 2166136261
  for i = 1, #s do h = ((h ~ sbyte(s, i)) * 16777619) & 0xffffffff end
  return h
end
local function det_pairs(t)
  if type(t) ~= "table" then error("bad argument #1 to 'pairs' (table expected, got " .. type(t) .. ")", 2) end
  local ks = {}
  for k in next, t do
    ks[#ks + 1] = { k, fnv(type(k) .. ":" .. tostring(type(k) == "table" and "" or k)) }
  end
  tsort(ks, function(a, b) return a[2] < b[2] end)
  local i = 0
  return function()
    i = i + 1
    local e = ks[i]
    if e then return e[1], t[e[1]] end
  end, t, nil
end

---------------------------------------------------------------- tools
local scope_tables = {}
local SCOPES = decode(scopes_json)
local function make_tool(scope, fname, schema)
  local full = scope .. "." .. fname
  return function(args, extra)
    if rawequal(args, scope_tables[scope]) then
      error("call tools with a dot: " .. full .. "{...}, not " .. scope .. ":" .. fname .. "{...}", 2)
    end
    if args == nil then args = {} end
    if type(args) ~= "table" then
      error(full .. " expects one table argument, e.g. " .. full .. "{id = 1}", 2)
    end
    local line = user_line()
    local ok, enc = pcall(encode, args, "args", schema, "args", {}, {})
    if not ok then error(full .. ": " .. tostring(enc), 2) end
    local res = decode(host_call(full, enc, line))
    if res.ok then return res.value end
    local e = res.error
    if e.kind == "budget" then error(BUDGET, 0) end
    setmetatable(e, ERR_MT)
    error(e, 0)
  end
end
for scope, fns in pairs(SCOPES) do
  local t = {}
  for fname, schema in pairs(fns) do t[fname] = make_tool(scope, fname, schema) end
  scope_tables[scope] = t
end

---------------------------------------------------------------- sandbox env
local function copy(src, skip)
  local r = {}
  for k, v in next, src do if not (skip and skip[k]) then r[k] = v end end
  return r
end
local LIB = {
  string = copy(string, { dump = true }),
  table = copy(table),
  math = copy(math, { random = true, randomseed = true }),
  utf8 = copy(utf8),
}
local DISABLED = {
  io = true, os = true, load = true, loadstring = true, dofile = true, loadfile = true, require = true,
  debug = true, coroutine = true, package = true, collectgarbage = true,
  setmetatable = true, getmetatable = true, rawget = true, rawset = true, rawequal = true, rawlen = true,
  parallel = true,
}

local logs, warnings, STATE

local function make_env()
  local env = {
    string = LIB.string, table = LIB.table, math = LIB.math, utf8 = LIB.utf8,
    select = select, pairs = det_pairs, ipairs = ipairs, next = next,
    tostring = tostring, tonumber = tonumber, type = type,
    pcall = safe_pcall, xpcall = safe_xpcall, error = error, assert = assert,
    print = function(...)
      local n, parts = select("#", ...), {}
      for i = 1, n do parts[i] = tostring((select(i, ...))) end
      if #logs < MAX_LOG_LINES then logs[#logs + 1] = sanitize_utf8(tconcat(parts, "\t")) end
    end,
    array = function(...) local n = select("#", ...); local a = new_array(n); for i = 1, n do a[i] = (select(i, ...)) end; return a end,
    object = function() return new_object() end,
    state = STATE,
  }
  for scope, t in next, scope_tables do env[scope] = t end
  return setmetatable(env, {
    __index = function(_, k)
      if DISABLED[k] then error("'" .. tostring(k) .. "' is not available in this sandbox", 2) end
      error("undefined global '" .. tostring(k) .. "'", 2)
    end,
    __newindex = function(_, k)
      error("cannot assign global '" .. tostring(k) .. "': use 'local " .. tostring(k) ..
        " = ...' (or state." .. tostring(k) .. " to keep it across runs)", 2)
    end,
  })
end

-- "last expression is the result": try `return <all>`, else split from the tail.
local function is_blank_or_comment(s) return sfind(s, "^%s*$") or sfind(s, "^%s*%-%-") end
local function compile(code, env)
  local f = load("return " .. code, "=run", "t", env)
  if f then return f end
  local lines = {}
  for l in (code .. "\n"):gmatch("(.-)\r?\n") do lines[#lines + 1] = l end
  local last = #lines
  while last > 0 and is_blank_or_comment(lines[last]) do last = last - 1 end
  for i = last, 2, -1 do
    local tail = tconcat(lines, "\n", i, #lines)
    if not is_blank_or_comment(lines[i]) and load("return " .. tail, "=run", "t", env) then
      local prefix = tconcat(lines, "\n", 1, i - 1)
      if load(prefix, "=run", "t", env) then
        local g = load(prefix .. "\nreturn " .. tail, "=run", "t", env)
        if g then return g end
      end
    end
  end
  return load(code, "=run", "t", env)
end

local function encode_result(r)
  return encode(r, "value", nil, "result", {}, {})
end

function __run(code, state_json)
  logs, warnings = {}, {}
  STATE = decode(state_json)
  if type(STATE) ~= "table" then STATE = new_object() end
  local env = make_env()
  local before = {}
  for k, v in next, STATE do before[k] = encode(v, "state", nil, "state." .. tostring(k), {}, {}) end

  local chunk, cerr = compile(code, env)
  if not chunk then
    return encode_result({ status = "syntax", error = { message = cerr, line = tonumber(cerr:match("^run:(%d+):")) }, logs = logs })
  end

  math.randomseed(0)
  local count = 0
  local exhausted = false
  debug.sethook(function()
    count = count + 1
    if exhausted or count * 1000 > MAX_INSTRUCTIONS then exhausted = true; error(BUDGET, 0) end
  end, "", 1000)
  local err_info
  local packed = tpack(xpcall(function() return tpack(chunk()) end, function(e)
    local info = { line = user_line() }
    if rawequal(e, BUDGET) then info.status = "budget"; info.message = tostring(BUDGET)
    elseif type(e) == "table" and getmetatable(e) == ERR_MT then
      info.status = "error"; info.message = tostring(e); info.kind = e.kind; info.tool = e.tool
      info.data = e.data
    elseif type(e) == "string" then
      info.status = is_fatal(e) and "budget" or "error"; info.message = e
      info.line = tonumber(e:match("^run:(%d+):")) or info.line
    else
      info.status = "error"; info.message = "error object is a " .. type(e) .. " value: " .. tostring(e)
    end
    err_info = info
    return info
  end))
  debug.sethook()

  -- commit state: top-level key diff
  local committed = { set = new_array(0), delete = new_array(0) }
  local after = {}
  if type(env.state) == "table" then
    for k, v in next, STATE do
      local e = encode(v, "state", nil, "state." .. tostring(k), {}, warnings)
      if e then after[tostring(k)] = e end
    end
  end
  for k, e in next, after do if before[k] ~= e then committed.set[#committed.set + 1] = k end end
  for k in next, before do if after[k] == nil then committed.delete[#committed.delete + 1] = k end end
  tsort(committed.set); tsort(committed.delete)
  local state_out = {}
  for k, e in next, after do state_out[#state_out + 1] = quote(k) .. ":" .. e end
  tsort(state_out)
  local state_json_out = "{" .. tconcat(state_out, ",") .. "}"

  local res = { logs = logs, warnings = warnings, committed = committed }
  if packed[1] then
    local r = packed[2]
    res.status = "ok"
    if r.n == 1 then res.value = r[1]; res.has_value = true
    elseif r.n > 1 then
      local a = new_array(r.n)
      for i = 1, r.n do a[i] = r[i] end
      res.value = a; res.has_value = true
    else res.has_value = false end
  else
    local info = err_info or { status = "error", message = tostring(packed[2]) }
    res.status = info.status
    info.status = nil
    res.error = info
  end
  -- encode value separately so a nil value is distinguishable from "no value"
  local value_json = res.has_value and encode(res.value, "value", nil, "value", {}, warnings) or "null"
  res.value = nil
  return encode_result(res) .. "\n" .. value_json .. "\n" .. state_json_out
end
