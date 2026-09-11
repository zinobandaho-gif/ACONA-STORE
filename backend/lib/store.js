/* ACONA STORE — lib/store.js
   Tiny JSON database layer (no dependencies).
   All tables live in backend/data/*.json and are read fresh on every
   access, so simultaneous requests never work on stale data. */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", ".."); // serves ACONA.html, assets, admin.html
const DATA = path.join(ROOT, "data");

const FILES = {
  products: path.join(DATA, "products.json"),
  orders: path.join(DATA, "orders.json"),
  newsletter: path.join(DATA, "newsletter.json"),
  sessions: path.join(DATA, "sessions.json"),
  coupons: path.join(DATA, "coupons.json"),
  config: path.join(DATA, "config.json"),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file); // atomic replace: readers never see half-written files
}

function seedIfMissing(file, shipped) {
  if (fs.existsSync(file)) return;
  try {
    if (shipped && fs.existsSync(shipped)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(shipped, file);
      return;
    }
  } catch (e) {}
}

function ensureSeeded() {
  // On fresh hosts (Render) root data/ starts empty: seed the public
  // catalog from the files shipped inside backend/data/.
  seedIfMissing(FILES.products, path.join(__dirname, "..", "data", "products.json"));
  seedIfMissing(FILES.coupons, path.join(__dirname, "..", "data", "coupons.json"));
  if (!fs.existsSync(FILES.orders)) writeJson(FILES.orders, []);
  if (!fs.existsSync(FILES.newsletter)) writeJson(FILES.newsletter, []);
  if (!fs.existsSync(FILES.sessions)) writeJson(FILES.sessions, []);
  if (!fs.existsSync(FILES.coupons)) {
    writeJson(FILES.coupons, [
      { code: "WELCOME10", pct: 10, min: 0, active: true },
    ]);
  }
}

function loadRawConfig() {
  return readJson(FILES.config, {});
}

module.exports = {
  ROOT,
  DATA,
  FILES,
  readJson,
  writeJson,
  ensureSeeded,
  loadRawConfig,
  getProducts: () => readJson(FILES.products, []),
  getOrders: () => readJson(FILES.orders, []),
  getNewsletter: () => readJson(FILES.newsletter, []),
  getSessions: () => readJson(FILES.sessions, []),
  getCoupons: () => readJson(FILES.coupons, []),
};
