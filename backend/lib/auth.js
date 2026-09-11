/* ACONA STORE — lib/auth.js
   Google OAuth2 login (authorization-code flow) + cookie sessions.
   Secrets are NEVER exposed to the browser: the client secret stays
   on the server and the browser only holds a random session id. */
"use strict";

const https = require("https");
const crypto = require("crypto");
const store = require("./store");

function googleCfg() {
  const c = store.loadRawConfig();
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || c.googleClientId || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || c.googleClientSecret || "",
  };
}

function httpsPostForm(urlString, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const body = new URLSearchParams(params).toString();
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("bad_token_response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function httpsGetJson(urlString, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      {
        method: "GET",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { Authorization: "Bearer " + token },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("bad_userinfo"));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function getSession(req) {
  const m = String(req.headers.cookie || "").match(
    /(?:^|;\s*)acona_sid=([A-Za-z0-9_-]{10,90})/
  );
  if (!m) return null;
  const list = store.getSessions();
  return list.find((s) => s.sid === m[1] && Date.now() < s.exp) || null;
}

function createSession(profile) {
  const sessions = store.getSessions();
  const sid = crypto.randomBytes(32).toString("base64url");
  sessions.push({
    sid,
    email: String(profile.email || "").slice(0, 120),
    name: String(profile.name || profile.email || "").slice(0, 80),
    picture: String(profile.picture || "").slice(0, 900000),
    profileCompleted: false,
    at: new Date().toISOString(),
    exp: Date.now() + 30 * 24 * 3600 * 1000, // 30 days
  });
  // Keep the table bounded: drop expired rows, cap at 500 newest.
  store.writeJson(
    store.FILES.sessions,
    sessions.filter((s) => Date.now() < s.exp).slice(-500)
  );
  return sid;
}

function updateSession(sid, patch) {
  const sessions = store.getSessions();
  const cur = sessions.find((s) => s.sid === sid);
  if (!cur) return null;
  if (patch.name !== undefined) cur.name = patch.name;
  if (patch.picture !== undefined) cur.picture = patch.picture;
  if (patch.profileCompleted !== undefined) {
    cur.profileCompleted = patch.profileCompleted;
  }
  store.writeJson(store.FILES.sessions, sessions);
  return cur;
}

function sessionCookie(sid) {
  return (
    "acona_sid=" + sid + "; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax"
  );
}

function logoutCookie() {
  return "acona_sid=; HttpOnly; Path=/; Max-Age=0";
}

module.exports = {
  googleCfg,
  httpsPostForm,
  httpsGetJson,
  getSession,
  createSession,
  updateSession,
  sessionCookie,
  logoutCookie,
};
