// ---------------------------------------------------------------------------
// Cloudflare Workers 书签中心后端（与 EdgeOne 版功能对等）
// 单文件 Worker：worker/index.js  ->  所有 /api/*
// 存储：Cloudflare KV 命名空间 "BOOKMARKS"（在 wrangler.toml 中绑定）
//   data/categories.json  -> [{id,name,sort,group,created_at}]
//   data/bookmarks.json   -> [{id,category_id,title,url,icon,note,sort,group,visits,last_visit_at,created_at}]
//   data/groups.json      -> [{id,name}]  分区列表（默认 个人区/工作区）
//   data/icons.json       -> { "<host>": "data:image/png;base64,...." }
//   data/password.json    -> { password: "..." }  可选覆盖 env.APP_PASSWORD
//   data/site.json        -> 站点信息（名称 / 作者 / 网址）
// 鉴权：Bearer Token（HMAC，Web Crypto）+ 可选 HttpOnly Cookie
// 静态资源：由 wrangler.toml 的 assets 绑定（ASSETS）托管 index.html / app.js
// ---------------------------------------------------------------------------

const PUBLIC = new Set(["categories", "bookmarks", "icon", "health"]);

// --------------------------- 基础工具 ---------------------------
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      ...extra,
    },
  });
}

function b64u(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function abToB64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function ctOfDataUrl(du) {
  const m = du.match(/^data:([^;]+);/);
  return m ? m[1] : "image/png";
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// --------------------------- KV 数据访问 ---------------------------
async function kvGet(env, key) {
  try {
    return await env.BOOKMARKS.get(key, "json");
  } catch {
    return null;
  }
}
async function kvPut(env, key, val) {
  await env.BOOKMARKS.put(key, JSON.stringify(val));
}
async function kvDel(env, key) {
  await env.BOOKMARKS.delete(key);
}

// --------------------------- 鉴权 ---------------------------
let PWD_CACHE = { t: 0, v: undefined };
async function getStoredPwd(env) {
  if (PWD_CACHE.v !== undefined && Date.now() - PWD_CACHE.t < 30000) return PWD_CACHE.v;
  let v = null;
  try {
    const p = await kvGet(env, "data/password.json");
    if (p && p.password) v = p.password;
  } catch {}
  PWD_CACHE = { t: Date.now(), v };
  return v;
}
async function setStoredPwd(env, pwd) {
  await kvPut(env, "data/password.json", { password: pwd, updated_at: Date.now() });
  PWD_CACHE = { t: 0, v: undefined };
}
function getPwd(env, stored) {
  return stored || env.APP_PASSWORD || "admin";
}

async function importKey(key) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function hmac(msg, key) {
  const k = await importKey(key);
  const buf = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(buf)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function b64url(obj) {
  return b64u(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

async function makeToken(pwd) {
  const exp = Date.now() + 7 * 86400000;
  const p = b64url({ exp });
  const sig = await hmac(p, pwd);
  return p + "." + sig;
}

async function verifyToken(tok, pwd) {
  try {
    const [p, sig] = tok.split(".");
    if (!p || !sig) return false;
    const expect = await hmac(p, pwd);
    if (sig !== expect) return false;
    const { exp } = JSON.parse(b64urlDecode(p));
    return exp > Date.now();
  } catch {
    return false;
  }
}

async function requireAuth(req, env) {
  const stored = await getStoredPwd(env);
  const pwd = getPwd(env, stored);
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && (await verifyToken(m[1], pwd))) return true;
  const cookie = req.headers.get("cookie") || "";
  const cm = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (cm && (await verifyToken(cm[1], pwd))) return true;
  return false;
}

// --------------------------- 数据访问 ---------------------------
async function getCats(env) {
  const arr = (await kvGet(env, "data/categories.json")) || [];
  for (const c of arr) if (!c.group) c.group = "personal";
  return arr;
}
async function setCats(env, arr) {
  await kvPut(env, "data/categories.json", arr);
}
async function getBms(env) {
  const arr = (await kvGet(env, "data/bookmarks.json")) || [];
  for (const b of arr) {
    if (!b.group) b.group = "personal";
    if (!b.icon && b.url) b.icon = null;
  }
  return arr;
}
async function setBms(env, arr) {
  await kvPut(env, "data/bookmarks.json", arr);
}
async function getIcons(env) {
  return (await kvGet(env, "data/icons.json")) || {};
}
async function setIcons(env, map) {
  await kvPut(env, "data/icons.json", map);
  ICON_CACHE = { t: 0, map: null }; // 写入即失效
}

// 图标读取很频繁（每个图标一个请求），在 isolate 内缓存 30 秒，避免反复解析大 JSON
let ICON_CACHE = { t: 0, map: null };
async function getIconsFast(env) {
  if (ICON_CACHE.map && Date.now() - ICON_CACHE.t < 30000) return ICON_CACHE.map;
  const map = await getIcons(env);
  ICON_CACHE = { t: Date.now(), map };
  return map;
}
async function getGroups(env) {
  let arr = (await kvGet(env, "data/groups.json")) || [];
  if (!arr.length) {
    arr = [{ id: "personal", name: "个人区" }, { id: "work", name: "工作区" }];
    await kvPut(env, "data/groups.json", arr);
  }
  return arr;
}
async function setGroups(env, arr) {
  await kvPut(env, "data/groups.json", arr);
}
async function getSite(env) {
  let o = (await kvGet(env, "data/site.json")) || {};
  if (!o.name) o.name = "gai溜子导航站";
  if (!o.author) o.author = "gai溜子到处跑";
  if (!o.url) o.url = "example.com";
  return o;
}
async function setSite(env, o) {
  await kvPut(env, "data/site.json", o);
}
function groupOf(q) {
  if (q && q !== "all") return q;
  return null;
}

// --------------------------- 访问锁 / 免密密钥 ---------------------------
// data/access.json -> { gate: true/false, key: "<长密钥>", updated_at }
// gate=true：进站必须验证（密码登录，或带 key 的免密链接）
// gate=false：内容公开只读，仅编辑需要登录
function genKey() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
let ACCESS_CACHE = { t: 0, v: null };
async function getAccess(env) {
  if (ACCESS_CACHE.v && Date.now() - ACCESS_CACHE.t < 30000) return ACCESS_CACHE.v;
  let o = (await kvGet(env, "data/access.json")) || {};
  let dirty = false;
  if (typeof o.gate !== "boolean") { o.gate = true; dirty = true; }
  if (typeof o.key !== "string" || o.key.length < 16) { o.key = genKey(); dirty = true; }
  if (dirty) await kvPut(env, "data/access.json", o);
  ACCESS_CACHE = { t: Date.now(), v: o };
  return o;
}
async function setAccess(env, o) {
  await kvPut(env, "data/access.json", o);
  ACCESS_CACHE = { t: 0, v: null };
}
function safeEqual(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authCookie(token, maxAge, secure) {
  return (
    "token=" + token +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge +
    (secure ? "; Secure" : "")
  );
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}

// 未通过访问锁时返回的锁屏页（不依赖任何静态资源）
function gatePage(site, msg) {
  const name = escHtml((site && site.name) || "书签中心");
  const tip = msg ? '<div class="err">' + escHtml(msg) + "</div>" : "";
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
    '<meta name="robots" content="noindex,nofollow" />' +
    "<title>需要密码 · " + name + "</title><style>" +
    "*{box-sizing:border-box}" +
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111217;color:#e8eaed;" +
    "font:14px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}" +
    ".card{width:340px;max-width:90vw;background:#181a20;border:1px solid #2a2e37;border-radius:14px;padding:26px 24px;text-align:center}" +
    ".lock{font-size:30px;margin-bottom:6px}" +
    "h1{margin:0 0 4px;font-size:16px;font-weight:600}" +
    "p{margin:0 0 16px;color:#8b929d;font-size:12px}" +
    "input{width:100%;background:#111217;border:1px solid #2a2e37;color:#e8eaed;border-radius:8px;padding:9px 11px;font:inherit;outline:none}" +
    "input:focus{border-color:#4f8cff}" +
    "button{width:100%;margin-top:10px;background:#4f8cff;border:none;color:#fff;border-radius:8px;padding:9px;font:inherit;cursor:pointer}" +
    "button:hover{background:#3b6fd4}" +
    "button:disabled{opacity:.6;cursor:default}" +
    ".err{color:#ff5d5d;font-size:12px;margin-top:10px;min-height:16px}" +
    "</style></head><body>" +
    '<form class="card" id="f"><div class="lock">🔒</div><h1>' + name + "</h1><p>请输入访问密码以进入</p>" +
    '<input id="p" type="password" placeholder="访问密码" autocomplete="current-password" autofocus />' +
    '<button id="b" type="submit">进入</button>' + tip + "</form>" +
    "<script>" +
    "var f=document.getElementById('f'),b=document.getElementById('b'),p=document.getElementById('p'),e=document.querySelector('.err');" +
    "f.addEventListener('submit',async function(ev){ev.preventDefault();b.disabled=true;b.textContent='验证中…';" +
    "try{var r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p.value})});" +
    "if(r.ok){location.replace('/');}else{e.textContent='密码错误';b.disabled=false;b.textContent='进入';}}" +
    "catch(err){e.textContent='网络错误，请重试';b.disabled=false;b.textContent='进入';}});" +
    "</script></body></html>";
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// --------------------------- 图标生成 ---------------------------
async function fetchIcon(host) {
  const sources = [
    "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(host) + "&sz=64",
    "https://icons.duckduckgo.com/ip3/" + encodeURIComponent(host) + ".ico",
  ];
  for (const url of sources) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (r.ok) {
        const buf = await r.arrayBuffer();
        if (buf && buf.byteLength > 32) {
          return "data:" + (r.headers.get("content-type") || "image/png") + ";base64," + abToB64(buf);
        }
      }
    } catch {
      // 继续下一个源
    }
  }
  return null;
}

function letterIcon(host) {
  const ch = (host || "?").charAt(0).toUpperCase();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<rect width="64" height="64" rx="12" fill="#4b5563"/>' +
    '<text x="32" y="43" font-size="34" text-anchor="middle" fill="#fff" font-family="sans-serif">' +
    ch +
    "</text></svg>";
  return "data:image/svg+xml;base64," + b64u(svg);
}

async function serveIcon(env, host, fallback = true) {
  const map = await getIconsFast(env);
  let du = map[host];
  if (!du && fallback) du = letterIcon(host);
  if (!du) return json({ error: "no icon" }, 404);
  const ct = ctOfDataUrl(du);
  const b64 = du.split(",")[1] || "";
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(buf, {
    headers: {
      "content-type": ct,
      // 图标长缓存 30 天；刷新图标时前端会带 &t= 时间戳，自动绕过缓存
      "cache-control": "public, max-age=2592000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}

// 仅由显式刷新或保存书签时后台触发；不阻塞请求、不自动写回失败占位图
async function maybeFetchIcon(env, host) {
  if (!host) return;
  const map = await getIcons(env);
  if (map[host]) return;
  const du = await fetchIcon(host);
  if (du) {
    map[host] = du;
    await setIcons(env, map);
  }
}

async function refreshAllIcons(env) {
  const bms = await getBms(env);
  const hosts = [...new Set(bms.map((b) => {
    try { return new URL(b.url).host; } catch { return null; }
  }).filter(Boolean))];
  const map = await getIcons(env);
  let n = 0;
  for (const h of hosts) {
    if (map[h]) { n++; continue; }
    const du = (await fetchIcon(h)) || letterIcon(h);
    map[h] = du;
    n++;
  }
  await setIcons(env, map);
  return { hosts: hosts.length, cached: n };
}

async function refreshOneIcon(env, host) {
  if (!host) return null;
  const map = await getIcons(env);
  const du = (await fetchIcon(host)) || letterIcon(host);
  map[host] = du;
  await setIcons(env, map);
  return du;
}

// --------------------------- 主路由 ---------------------------
export default {
  async fetch(request, env, ctx) {
    if (!env.BOOKMARKS) {
      return json({ error: "KV 命名空间 BOOKMARKS 未绑定，请在 wrangler.toml 配置后部署" }, 500);
    }
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // 非 /api 请求：先过访问锁，再交给 Workers Assets 托管静态前端
    if (!url.pathname.startsWith("/api")) {
      const acc = await getAccess(env);
      if (acc.gate) {
        // 免密链接：/?key=<长密钥>  或  /k/<长密钥>
        const keyParam =
          url.searchParams.get("key") ||
          (url.pathname.startsWith("/k/") ? decodeURIComponent(url.pathname.slice(3).split("/")[0]) : "");
        if (keyParam) {
          if (safeEqual(keyParam, acc.key)) {
            const pwd = getPwd(env, await getStoredPwd(env));
            const token = await makeToken(pwd);
            return new Response(null, {
              status: 302,
              headers: {
                location: "/",
                "set-cookie": authCookie(token, 30 * 86400, url.protocol === "https:"),
                "cache-control": "no-store",
              },
            });
          }
        }
        if (!(await requireAuth(request, env))) {
          // 静态子资源不返回锁屏 HTML，直接拒绝
          if (/\.(js|css|png|jpe?g|gif|svg|ico|webp|woff2?|json|map)$/i.test(url.pathname)) {
            return new Response("locked", { status: 403, headers: { "cache-control": "no-store" } });
          }
          return gatePage(await getSite(env));
        }
      }
      // HTML 不缓存（否则锁屏/已登录状态会串号）
      // 带 v= 版本号的静态资源（app.js?v=xxx）可长缓存 1 年：改版时版本号变化 = 新 URL，自动取新文件
      // 不带版本号的按 5 分钟兜底，避免裸路径下拿到旧文件
      const resp = await env.ASSETS.fetch(request);
      const ct = resp.headers.get("content-type") || "";
      const cc = ct.includes("text/html")
        ? "no-store, must-revalidate"
        : url.searchParams.has("v")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300";
      const hdr = new Headers(resp.headers);
      hdr.set("cache-control", cc);
      hdr.set("x-cc-by", "worker");
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: hdr });
    }

    const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }

    const head = parts[0] || "";

    if (head === "health") return json({ ok: true });

    if (method === "POST" && head === "login") {
      const body = await readBody(request);
      const stored = await getStoredPwd(env);
      const pwd = getPwd(env, stored);
      if (!body.password || body.password !== pwd) return json({ error: "密码错误" }, 401);
      const token = await makeToken(pwd);
      return json({ ok: true, token }, 200, {
        "set-cookie": authCookie(token, 7 * 86400, url.protocol === "https:"),
      });
    }

    // 退出：清除访问锁 Cookie（任何状态都可调用）
    if (method === "POST" && head === "logout") {
      const clear = "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (url.protocol === "https:" ? "; Secure" : "");
      return json({ ok: true }, 200, { "set-cookie": clear });
    }

    if (head === "icon" && method === "GET") {
      const host = url.searchParams.get("host");
      if (!host) return json({ error: "missing host" }, 400);
      // 访问锁开启时，图标同样需要登录（浏览器同源 img 请求会自动带 Cookie）
      const accIcon = await getAccess(env);
      if (accIcon.gate && !(await requireAuth(request, env))) return json({ error: "unauthorized" }, 401);
      return serveIcon(env, host);
    }

    // 访问锁开启时：所有 /api 数据接口（含只读）都必须已通过验证
    // 访问锁关闭时：只读接口公开，写入 / 敏感接口仍需登录
    const acc = await getAccess(env);
    const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const sensitive = ["backup", "restore", "data", "icons", "access", "password"];
    if (acc.gate || isWrite || sensitive.includes(head)) {
      if (!(await requireAuth(request, env))) return json({ error: "unauthorized" }, 401);
    }

    // ---- 首屏一次性拉取（减少 4 次往返 + 4 次 KV 冷读）----
    if (head === "bootstrap" && method === "GET") {
      const [groups, categories, bookmarks, site] = await Promise.all([
        getGroups(env),
        getCats(env),
        getBms(env),
        getSite(env),
      ]);
      const data = { version: 3, groups, categories, bookmarks, site, ts: Date.now() };
      if (url.searchParams.get("icons") === "1") data.icons = await getIcons(env);
      return json(data, 200, { "cache-control": "no-store" });
    }

    // ---- 分类 ----
    if (head === "categories") {
      if (method === "GET") {
        const cats = await getCats(env);
        const g = groupOf(url.searchParams.get("group"));
        return json(g ? cats.filter((c) => c.group === g) : cats);
      }
      if (method === "POST") {
        const body = await readBody(request);
        const cats = await getCats(env);
        const maxSort = cats.reduce((m, c) => Math.max(m, c.sort || 0), 0);
        const cat = {
          id: crypto.randomUUID(),
          name: String(body.name || "未命名"),
          sort: body.sort != null ? Number(body.sort) : maxSort + 1,
          group: (typeof body.group === "string" && body.group) ? body.group : "personal",
          created_at: Date.now(),
        };
        cats.push(cat);
        await setCats(env, cats);
        return json(cat, 201);
      }
      const id = parts[1];
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(request);
        const cats = await getCats(env);
        const c = cats.find((x) => x.id === id);
        if (!c) return json({ error: "not found" }, 404);
        if (body.name != null) c.name = String(body.name);
        if (body.sort != null) c.sort = Number(body.sort);
        if (typeof body.group === "string" && body.group && body.group !== c.group) {
          const newGroup = body.group;
          c.group = newGroup;
          // 级联：把该分类下的书签一并移动到新分区
          const bms = await getBms(env);
          for (const b of bms) if (b.category_id === id) b.group = newGroup;
          await setBms(env, bms);
        }
        await setCats(env, cats);
        return json(c);
      }
      if (method === "DELETE") {
        const cats = await getCats(env);
        const bms = await getBms(env);
        const remaining = cats.filter((x) => x.id !== id);
        if (remaining.length === cats.length) return json({ error: "not found" }, 404);
        const newBms = bms.filter((x) => x.category_id !== id);
        await setCats(env, remaining);
        await setBms(env, newBms);
        return json({
          ok: true,
          deleted: cats.length - remaining.length,
          bookmarksDeleted: bms.length - newBms.length,
        });
      }
    }

    // ---- 书签 ----
    if (head === "bookmarks") {
      if (method === "GET") {
        const bms = await getBms(env);
        const g = groupOf(url.searchParams.get("group"));
        return json(g ? bms.filter((b) => b.group === g) : bms);
      }
      if (method === "POST") {
        const body = await readBody(request);
        if (!body.url) return json({ error: "url required" }, 400);
        const bms = await getBms(env);
        const maxSort = bms.reduce((m, b) => Math.max(m, b.sort || 0), 0);
        const host = (() => {
          try { return new URL(body.url).host; } catch { return null; }
        })();
        const bm = {
          id: crypto.randomUUID(),
          category_id: body.category_id || null,
          title: String(body.title || body.url),
          url: String(body.url),
          icon: body.icon || null,
          note: body.note || null,
          sort: body.sort != null ? Number(body.sort) : maxSort + 1,
          group: (typeof body.group === "string" && body.group) ? body.group : "personal",
          visits: 0,
          last_visit_at: null,
          created_at: Date.now(),
        };
        bms.push(bm);
        await setBms(env, bms);
        if (host && ctx && ctx.waitUntil) ctx.waitUntil(maybeFetchIcon(env, host));
        return json(bm, 201);
      }
      const id = parts[1];
      if (!id) return json({ error: "id required" }, 400);
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(request);
        const bms = await getBms(env);
        const b = bms.find((x) => x.id === id);
        if (!b) return json({ error: "not found" }, 404);
        for (const f of ["title", "url", "icon", "note", "sort"]) {
          if (body[f] != null) b[f] = f === "sort" ? Number(body[f]) : body[f];
        }
        if (body.category_id !== undefined) b.category_id = body.category_id; // 允许显式置 null
        if (typeof body.group === "string" && body.group) b.group = body.group;
        await setBms(env, bms);
        const host = body.url
          ? (() => {
              try { return new URL(body.url).host; } catch { return null; }
            })()
          : null;
        if (host && ctx && ctx.waitUntil) ctx.waitUntil(maybeFetchIcon(env, host));
        return json(b);
      }
      if (method === "DELETE") {
        const bms = await getBms(env);
        const remaining = bms.filter((x) => x.id !== id);
        if (remaining.length === bms.length) return json({ error: "not found" }, 404);
        await setBms(env, remaining);
        return json({ ok: true });
      }
    }

    // ---- 备份 / 恢复 / 清空 ----
    if (head === "backup" && method === "GET") {
      const [cats, bms, icons, groups] = await Promise.all([getCats(env), getBms(env), getIcons(env), getGroups(env)]);
      return json({
        version: 3,
        generator: "bookmark-hub-cf",
        exportedAt: new Date().toISOString(),
        groups,
        categories: cats,
        bookmarks: bms,
        icons,
      });
    }

    if (head === "restore" && method === "POST") {
      const body = await readBody(request);
      if (!body || !Array.isArray(body.categories) || !Array.isArray(body.bookmarks))
        return json({ error: "invalid backup" }, 400);
      let icons = {};
      if (body.icons && typeof body.icons === "object") {
        for (const [h, v] of Object.entries(body.icons)) {
          if (typeof v === "string") icons[h] = v;
          else if (v && v.b64) icons[h] = "data:" + (v.ct || "image/png") + ";base64," + v.b64;
        }
      }
      // 分区：优先用备份里的 groups；并补齐书签/分类引用到、但备份缺失的分区，
      // 避免恢复后自定义分区“消失”、其书签变成无标签页可挂的孤儿。
      let groups = [];
      if (Array.isArray(body.groups)) {
        for (const g of body.groups) {
          if (g && g.id) groups.push({ id: String(g.id), name: String(g.name || g.id) });
        }
      }
      const have = new Set(groups.map((g) => g.id));
      const need = new Set();
      for (const c of body.categories) if (c && c.group) need.add(String(c.group));
      for (const b of body.bookmarks) if (b && b.group) need.add(String(b.group));
      for (const gid of need) {
        if (!have.has(gid)) { groups.push({ id: gid, name: "分区 " + gid }); have.add(gid); }
      }
      await setCats(env, body.categories);
      await setBms(env, body.bookmarks);
      await setIcons(env, icons);
      if (groups.length) await setGroups(env, groups);
      return json({
        ok: true,
        categories: body.categories.length,
        bookmarks: body.bookmarks.length,
        icons: Object.keys(icons).length,
        groups: groups.length,
      });
    }

    if (head === "data" && method === "DELETE") {
      await kvDel(env, "data/categories.json");
      await kvDel(env, "data/bookmarks.json");
      await kvDel(env, "data/icons.json");
      return json({ ok: true });
    }

    if (head === "icons") {
      if (method === "GET") {
        const icons = await getIcons(env);
        return json(icons);
      }
      if (parts[1] === "refresh" && method === "POST") {
        const body = await readBody(request);
        if (body && body.host) {
          const du = await refreshOneIcon(env, String(body.host));
          return json({
            ok: true,
            host: body.host,
            refreshed: true,
            hasIcon: !!du && !String(du).startsWith("data:image/svg"),
          });
        }
        const r = await refreshAllIcons(env);
        return json({ ok: true, ...r });
      }
    }

    if (head === "password" && method === "POST") {
      const body = await readBody(request);
      if (!body.password || typeof body.password !== "string" || body.password.length < 1)
        return json({ error: "password required" }, 400);
      await setStoredPwd(env, body.password);
      const token = await makeToken(body.password);
      return json({ ok: true, token }, 200, {
        "set-cookie": authCookie(token, 7 * 86400, url.protocol === "https:"),
      });
    }

    // ---- 访问锁 / 免密密钥 ----
    if (head === "access") {
      if (method === "GET") {
        const a = await getAccess(env);
        return json({ gate: a.gate, key: a.key });
      }
      if (method === "POST") {
        const body = await readBody(request);
        const a = await getAccess(env);
        if (body.gate === true || body.gate === false) a.gate = body.gate;
        if (body.regenerate) a.key = genKey();
        else if (typeof body.key === "string") {
          const k = body.key.trim();
          if (k.length >= 8) a.key = k;
          else return json({ error: "密钥至少 8 位" }, 400);
        }
        a.updated_at = Date.now();
        await setAccess(env, a);
        return json({ gate: a.gate, key: a.key });
      }
    }

    // ---- 分区 ----
    if (head === "groups") {
      if (method === "GET") {
        const g = await getGroups(env);
        return json(g);
      }
      if (method === "POST") {
        const body = await readBody(request);
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "名称必填" }, 400);
        const g = await getGroups(env);
        const id = body.id && /^[A-Za-z0-9_-]{1,32}$/.test(String(body.id)) ? String(body.id) : crypto.randomUUID().slice(0, 8);
        if (g.find((x) => x.id === id)) return json({ error: "该分区已存在" }, 409);
        const ng = { id, name };
        g.push(ng);
        await setGroups(env, g);
        return json(ng, 201);
      }
      const id = parts[1];
      if (method === "PUT" || method === "PATCH") {
        if (!id) return json({ error: "id required" }, 400);
        const body = await readBody(request);
        const g = await getGroups(env);
        const target = g.find((x) => x.id === id);
        if (!target) return json({ error: "not found" }, 404);
        if (body.name != null) {
          const name = String(body.name).trim();
          if (!name) return json({ error: "名称必填" }, 400);
          target.name = name;
        }
        await setGroups(env, g);
        return json(target);
      }
      if (method === "DELETE") {
        if (!id) return json({ error: "id required" }, 400);
        const g = await getGroups(env);
        if (g.length <= 1) return json({ error: "至少保留一个分区" }, 400);
        const target = g.find((x) => x.id === id);
        if (!target) return json({ error: "not found" }, 404);
        const fallback = g.find((x) => x.id !== id).id;
        const cats = await getCats(env);
        const bms = await getBms(env);
        for (const c of cats) if (c.group === id) c.group = fallback;
        for (const b of bms) if (b.group === id) b.group = fallback;
        await setCats(env, cats);
        await setBms(env, bms);
        await setGroups(env, g.filter((x) => x.id !== id));
        return json({ ok: true, fallback });
      }
    }

    // ---- 站点信息 ----
    if (head === "site") {
      if (method === "GET") {
        const o = await getSite(env);
        return json(o);
      }
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(request);
        const o = await getSite(env);
        if (body.name != null) o.name = String(body.name).slice(0, 40);
        if (body.author != null) o.author = String(body.author).slice(0, 40);
        if (body.url != null) o.url = String(body.url).slice(0, 120);
        await setSite(env, o);
        return json(o);
      }
    }

    return json({ error: "not found", path }, 404);
  },
};
