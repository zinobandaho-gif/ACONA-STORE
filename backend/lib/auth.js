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

function firebaseCfg() {
  const c = store.loadRawConfig();
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || c.firebaseProjectId || "acona-store",
  };
}

/* ----- Firebase ID-token verification (zero dependencies) -----
   Verifies RS256 JWTs from Firebase Auth using Google's public certs.
   An unverifiable token NEVER creates a session. */
let _fbCerts = { keys: null, exp: 0 };

function _b64urlToBuf(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function _httpsGetRaw(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      {
        method: "GET",
        hostname: u.hostname,
        path: u.pathname + u.search,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ data, headers: res.headers || {} }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function _getFirebaseCerts(force) {
  if (!force && _fbCerts.keys && Date.now() < _fbCerts.exp) return _fbCerts.keys;
  const { data, headers } = await _httpsGetRaw(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
  );
  const keys = JSON.parse(data);
  let maxAge = 3600;
  const m = String((headers && headers["cache-control"]) || "").match(/max-age=(\d+)/);
  if (m) maxAge = Math.max(300, Number(m[1]));
  _fbCerts = { keys, exp: Date.now() + maxAge * 1000 };
  return keys;
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("bad_token");
  let header, payload;
  try {
    header = JSON.parse(_b64urlToBuf(parts[0]).toString("utf8"));
    payload = JSON.parse(_b64urlToBuf(parts[1]).toString("utf8"));
  } catch (e) {
    throw new Error("bad_token");
  }
  if (!header || header.alg !== "RS256") throw new Error("bad_alg");
  let certs = await _getFirebaseCerts(false);
  let cert = certs[header.kid];
  if (!cert) {
    certs = await _getFirebaseCerts(true);
    cert = certs[header.kid];
  }
  if (!cert) throw new Error("bad_kid");
  const v = crypto.createVerify("RSA-SHA256");
  v.update(parts[0] + "." + parts[1]);
  if (!v.verify(cert, _b64urlToBuf(parts[2]))) throw new Error("bad_sig");
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("bad_aud");
  if (payload.iss !== "https://securetoken.google.com/" + projectId) {
    throw new Error("bad_iss");
  }
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("bad_sub");
  if (typeof payload.exp !== "number" || payload.exp < now - 30) {
    throw new Error("expired");
  }
  if (typeof payload.iat !== "number" || payload.iat > now + 120) {
    throw new Error("bad_iat");
  }
  return payload;
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
  firebaseCfg,
  verifyFirebaseIdToken,
  httpsPostForm,
  httpsGetJson,
  getSession,
  createSession,
  updateSession,
  sessionCookie,
  logoutCookie,
};
