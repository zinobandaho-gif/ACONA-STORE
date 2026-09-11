/* ==========================================================
   ACONA STORE Backend — zero dependencies (Node.js built-ins only).

   Layout:
     server.js      HTTP bootstrap + route table (this file)
     lib/store.js   JSON database layer  (data/*.json)
     lib/auth.js    Google OAuth2 + cookie sessions
     lib/orders.js  order validation, coupons, pricing, stats

   Run:
     node server.js   →  http://localhost:3000/ACONA.html
   Env:
     PORT, ADMIN_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
   ========================================================== */
"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");

const store = require("./lib/store");
const auth = require("./lib/auth");
const orders = require("./lib/orders");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || store.loadRawConfig().adminToken || "acona-admin-2026";

store.ensureSeeded();

/* ---------- 1. HTTP helpers ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  res.writeHead(code, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > (limit || 102400)) {
        reject(new Error("too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

/* ---------- 2. Static files (no path traversal) ---------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/ACONA.html";
  const safe = path.normalize(rel).replace(/^([/\\])+/, "");
  const file = path.join(store.ROOT, safe);
  if (!file.startsWith(store.ROOT)) return send(res, 403, "Forbidden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    fs.readFile(file, (err2, data) => {
      if (err2) return send(res, 500, "Server error");
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
    });
  });
}

/* ---------- 3. Route handlers ---------- */
async function handleGoogleStart(req, res) {
  const g = auth.googleCfg();
  if (!g.clientId) return sendJson(res, 500, { error: "google_not_configured" });
  const redirect =
    "http://" + (req.headers.host || "localhost:" + PORT) + "/api/auth/google/callback";
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", g.clientId);
  target.searchParams.set("redirect_uri", redirect);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("prompt", "select_account");
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

async function handleGoogleCallback(req, res, u) {
  const g = auth.googleCfg();
  const code = u.searchParams.get("code");
  const fail = () => {
    res.writeHead(302, { Location: "/ACONA.html?login=fail" });
    res.end();
  };
  if (!g.clientId || !g.clientSecret || !code) return fail();
  try {
    const redirect =
      "http://" + (req.headers.host || "localhost:" + PORT) + "/api/auth/google/callback";
    const tok = await auth.httpsPostForm("https://oauth2.googleapis.com/token", {
      code,
      client_id: g.clientId,
      client_secret: g.clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    });
    if (!tok.access_token) throw new Error("no_token");
    const me = await auth.httpsGetJson(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      tok.access_token
    );
    if (!me.email) throw new Error("no_email");
    const sid = auth.createSession(me);
    res.writeHead(302, {
      Location: "/ACONA.html?login=ok",
      "Set-Cookie": auth.sessionCookie(sid),
    });
    res.end();
  } catch (e) {
    fail();
  }
}

async function handleUpdateProfile(req, res) {
  const s = auth.getSession(req);
  if (!s) return sendJson(res, 401, { error: "guest" });
  let body;
  try {
    body = await readBody(req, 1024 * 1024);
  } catch (e) {
    return sendJson(res, 400, { error: "bad_request" });
  }
  const name = String(body.name || "").trim().slice(0, 40);
  if (name.length < 2) return sendJson(res, 400, { error: "invalid_name" });
  let picture = s.picture || "";
  if (typeof body.picture === "string" && body.picture.length) {
    if (
      !/^data:image\/(png|jpeg|webp);base64,/.test(body.picture) ||
      body.picture.length > 900000
    ) {
      return sendJson(res, 400, { error: "invalid_picture" });
    }
    picture = body.picture.slice(0, 900000);
  }
  const cur = auth.updateSession(s.sid, { name, picture, profileCompleted: true });
  if (!cur) return sendJson(res, 401, { error: "guest" });
  return sendJson(res, 200, {
    ok: true,
    email: cur.email,
    name: cur.name,
    picture: cur.picture,
    profileCompleted: true,
  });
}

async function handleCreateOrder(req, res) {
  const body = await readBody(req);
  const v = orders.validateOrder(body);
  if (v.errors.length) return sendJson(res, 400, { error: "invalid", fields: v.errors });
  const order = orders.buildOrder(v);
  const all = store.getOrders();
  all.push(order);
  store.writeJson(store.FILES.orders, all);
  return sendJson(res, 201, {
    number: order.number,
    total: order.total,
    subtotal: order.subtotal,
    discount: order.discount,
    shipping: order.shipping,
  });
}

function validProductInput(b, partial) {
  const cats = ["phones", "laptops", "audio", "wear", "acc"];
  const out = {};
  if (b.cat !== undefined || !partial) {
    if (!cats.includes(b.cat)) return { error: "bad_cat" };
    out.cat = b.cat;
  }
  if (b.price !== undefined || !partial) {
    const price = Number(b.price);
    if (!Number.isFinite(price) || price < 1 || price > 1000000) return { error: "bad_price" };
    out.price = Math.round(price);
  }
  if (b.old !== undefined) {
    const old = Number(b.old);
    if (!Number.isFinite(old) || old < 1) return { error: "bad_old" };
    out.old = Math.round(old);
  }
  if (b.rate !== undefined) {
    const rate = Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 5) return { error: "bad_rate" };
    out.rate = Math.round(rate * 10) / 10;
  }
  if (b.pop !== undefined) {
    const pop = Number(b.pop);
    if (!Number.isInteger(pop) || pop < 0 || pop > 999) return { error: "bad_pop" };
    out.pop = pop;
  }
  for (const lang of ["en", "fr"]) {
    if (b[lang] !== undefined || !partial) {
      const n = String((b[lang] || {}).n || "").trim().slice(0, 80);
      const s = String((b[lang] || {}).s || "").trim().slice(0, 160);
      if (!n) return { error: "bad_name" };
      out[lang] = { n, s };
    }
  }
  return { value: out };
}

/* ---------- 4. Router ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const p = u.pathname;
  try {
    // ----- public: shop -----
    if (req.method === "GET" && p === "/api/health") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }
    if (req.method === "GET" && p === "/api/products") {
      return sendJson(res, 200, store.getProducts());
    }
    if (req.method === "GET" && p.startsWith("/api/products/")) {
      const id = Number(p.split("/").pop());
      const prod = store.getProducts().find((x) => x.id === id);
      return prod ? sendJson(res, 200, prod) : sendJson(res, 404, { error: "not_found" });
    }
    if (req.method === "GET" && p.startsWith("/api/coupon/")) {
      const code = decodeURIComponent(p.split("/").pop()).toUpperCase().slice(0, 24);
      const c = store.getCoupons().find((x) => x.code === code && x.active);
      return c
        ? sendJson(res, 200, { code: c.code, pct: c.pct, min: c.min })
        : sendJson(res, 404, { error: "invalid_coupon" });
    }
    if (req.method === "POST" && p === "/api/orders") {
      return handleCreateOrder(req, res);
    }
    if (req.method === "GET" && p.startsWith("/api/orders/")) {
      const number = decodeURIComponent(p.split("/").pop()).slice(0, 20);
      const phone = (u.searchParams.get("phone") || "").trim();
      const order = store
        .getOrders()
        .find((o) => o.number === number && o.customer.phone === phone);
      return order ? sendJson(res, 200, order) : sendJson(res, 404, { error: "not_found" });
    }
    if (req.method === "POST" && p === "/api/newsletter") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return sendJson(res, 400, { error: "invalid_email" });
      }
      const list = store.getNewsletter();
      if (!list.some((e) => e.email === email)) {
        list.push({ email, at: new Date().toISOString() });
        store.writeJson(store.FILES.newsletter, list);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ----- public: auth -----
    if (req.method === "GET" && p === "/api/auth/google/start") {
      return handleGoogleStart(req, res);
    }
    if (req.method === "GET" && p === "/api/auth/google/callback") {
      return handleGoogleCallback(req, res, u);
    }
    if (req.method === "GET" && p === "/api/me") {
      const s = auth.getSession(req);
      return s
        ? sendJson(res, 200, {
            email: s.email,
            name: s.name,
            picture: s.picture,
            profileCompleted: !!s.profileCompleted,
          })
        : sendJson(res, 401, { error: "guest" });
    }
    if (req.method === "PUT" && p === "/api/profile") {
      return handleUpdateProfile(req, res);
    }
    if (req.method === "POST" && p === "/api/auth/logout") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": auth.logoutCookie(),
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // ----- admin (token required) -----
    const isAdmin =
      req.headers["x-admin-token"] === ADMIN_TOKEN ||
      u.searchParams.get("token") === ADMIN_TOKEN;
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin) return sendJson(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && p === "/api/admin/stats") {
        return sendJson(res, 200, orders.stats());
      }
      if (req.method === "GET" && p === "/api/admin/orders") {
        return sendJson(res, 200, store.getOrders().slice().reverse());
      }
      if (req.method === "PUT" && p.startsWith("/api/admin/orders/")) {
        const number = decodeURIComponent(p.split("/").pop()).slice(0, 20);
        const body = await readBody(req);
        if (!orders.STATUSES.includes(String(body.status || ""))) {
          return sendJson(res, 400, { error: "bad_status" });
        }
        const all = store.getOrders();
        const o = all.find((x) => x.number === number);
        if (!o) return sendJson(res, 404, { error: "not_found" });
        o.status = body.status;
        store.writeJson(store.FILES.orders, all);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && p === "/api/admin/newsletter") {
        return sendJson(res, 200, store.getNewsletter());
      }
      if (req.method === "GET" && p === "/api/admin/sessions") {
        // Never leak session ids to the admin panel.
        return sendJson(
          res,
          200,
          store.getSessions().map((s) => ({
            email: s.email,
            name: s.name,
            at: s.at,
          }))
        );
      }
      if (req.method === "GET" && p === "/api/admin/coupons") {
        return sendJson(res, 200, store.getCoupons());
      }
      if (req.method === "POST" && p === "/api/admin/coupons") {
        const body = await readBody(req);
        const code = String(body.code || "").trim().toUpperCase().slice(0, 24);
        const pct = Number(body.pct);
        const min = Number(body.min || 0);
        if (!/^[A-Z0-9]{3,24}$/.test(code)) return sendJson(res, 400, { error: "bad_code" });
        if (!Number.isFinite(pct) || pct < 1 || pct > 90) {
          return sendJson(res, 400, { error: "bad_pct" });
        }
        if (!Number.isFinite(min) || min < 0) return sendJson(res, 400, { error: "bad_min" });
        const list = store.getCoupons();
        if (list.some((c) => c.code === code)) return sendJson(res, 409, { error: "exists" });
        list.push({ code, pct, min, active: body.active !== false });
        store.writeJson(store.FILES.coupons, list);
        return sendJson(res, 201, { ok: true });
      }
      if ((req.method === "PUT" || req.method === "DELETE") && p.startsWith("/api/admin/coupons/")) {
        const code = decodeURIComponent(p.split("/").pop()).toUpperCase().slice(0, 24);
        const list = store.getCoupons();
        const c = list.find((x) => x.code === code);
        if (!c) return sendJson(res, 404, { error: "not_found" });
        if (req.method === "DELETE") {
          store.writeJson(
            store.FILES.coupons,
            list.filter((x) => x.code !== code)
          );
          return sendJson(res, 200, { ok: true });
        }
        const body = await readBody(req);
        if (body.pct !== undefined) {
          if (!Number.isFinite(Number(body.pct)) || body.pct < 1 || body.pct > 90) {
            return sendJson(res, 400, { error: "bad_pct" });
          }
          c.pct = Number(body.pct);
        }
        if (body.min !== undefined) {
          if (!Number.isFinite(Number(body.min)) || body.min < 0) {
            return sendJson(res, 400, { error: "bad_min" });
          }
          c.min = Number(body.min);
        }
        if (body.active !== undefined) c.active = !!body.active;
        store.writeJson(store.FILES.coupons, list);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/admin/products") {
        const body = await readBody(req);
        const v = validProductInput(body, false);
        if (v.error) return sendJson(res, 400, { error: v.error });
        const list = store.getProducts();
        const id = list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
        const prod = Object.assign({ id, old: v.value.price, rate: 5, pop: 50 }, v.value);
        list.push(prod);
        store.writeJson(store.FILES.products, list);
        return sendJson(res, 201, prod);
      }
      if (
        (req.method === "PUT" || req.method === "DELETE") &&
        p.startsWith("/api/admin/products/")
      ) {
        const id = Number(p.split("/").pop());
        const list = store.getProducts();
        const idx = list.findIndex((x) => x.id === id);
        if (idx < 0) return sendJson(res, 404, { error: "not_found" });
        if (req.method === "DELETE") {
          list.splice(idx, 1);
          store.writeJson(store.FILES.products, list);
          return sendJson(res, 200, { ok: true });
        }
        const body = await readBody(req);
        const v = validProductInput(body, true);
        if (v.error) return sendJson(res, 400, { error: v.error });
        Object.assign(list[idx], v.value);
        if (v.value.en) list[idx].en = v.value.en;
        if (v.value.fr) list[idx].fr = v.value.fr;
        store.writeJson(store.FILES.products, list);
        return sendJson(res, 200, list[idx]);
      }
      return sendJson(res, 404, { error: "not_found" });
    }

    // ----- static site -----
    if (req.method === "GET") return serveStatic(req, res, p);
    return send(res, 405, "Method not allowed");
  } catch (e) {
    const code = e && e.message === "too_large" ? 413 : 400;
    return sendJson(res, code, { error: e && e.message ? e.message : "bad_request" });
  }
});

/* ---------- 5. Boot ---------- */
server.listen(PORT, () => {
  console.log("ACONA STORE backend running: http://localhost:" + PORT + "/ACONA.html");
  console.log("Admin dashboard:             http://localhost:" + PORT + "/admin.html");
  if (!process.env.ADMIN_TOKEN) {
    console.log("WARNING: using default ADMIN_TOKEN, set ADMIN_TOKEN env in production!");
  }
});
