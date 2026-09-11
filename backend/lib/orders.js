/* ACONA STORE — lib/orders.js
   Order validation, coupon handling and price computation.
   RULE: the server is the source of truth for prices — the client
   only sends product ids + quantities, never totals. */
"use strict";

const crypto = require("crypto");
const store = require("./store");

const FREE_SHIP_AT = 150;
const SHIP_COST = 9;
const STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

function esc(s) {
  return String(s == null ? "" : s).slice(0, 500);
}

function findCoupon(code) {
  const clean = String(code || "").trim().toUpperCase().slice(0, 24);
  if (!clean) return null;
  const c = store.getCoupons().find((x) => x.code === clean && x.active);
  return c || null;
}

function validateOrder(body) {
  const errors = [];
  const customer = body.customer || {};
  const name = String(customer.name || "").trim();
  const phone = String(customer.phone || "").trim();
  const addr = String(customer.address || "").trim();
  const city = String(customer.city || "Other").trim().slice(0, 60);
  if (name.length < 3) errors.push("name");
  if (!/^[0-9+\s-]{8,20}$/.test(phone)) errors.push("phone");
  if (addr.length < 5) errors.push("address");

  const payMethod = body.payMethod === "card" ? "card" : "cod";
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 50) errors.push("items");

  const catalog = new Map(store.getProducts().map((p) => [p.id, p]));
  const lines = [];
  for (const it of items) {
    const id = Number(it.id);
    const qty = Number(it.qty);
    const p = catalog.get(id);
    if (!p || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      errors.push("items");
      break;
    }
    lines.push({ id: p.id, cat: p.cat, qty, price: p.price, name: p.en.n });
  }

  let cardLast4 = null;
  if (payMethod === "card") {
    // NEVER send full card numbers to this server — last 4 digits only.
    cardLast4 = String(body.cardLast4 || "").replace(/\D/g, "").slice(-4);
    if (!/^\d{4}$/.test(cardLast4)) errors.push("card");
  }

  // Coupon is optional; an unknown/inactive code is simply ignored.
  let coupon = null;
  let discount = 0;
  const sub = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const found = findCoupon(body.coupon);
  if (found && sub >= Number(found.min || 0)) {
    coupon = found.code;
    discount = Math.min(
      sub,
      Math.round((sub * Number(found.pct || 0)) / 100)
    );
  }

  const ship = sub - discount >= FREE_SHIP_AT ? 0 : SHIP_COST;
  return {
    errors,
    name: esc(name),
    phone: esc(phone),
    address: esc(addr),
    city: esc(city),
    payMethod,
    lines,
    cardLast4,
    coupon,
    subtotal: sub,
    discount,
    shipping: ship,
    total: sub - discount + ship,
  };
}

function newOrderNumber(existing) {
  const set = new Set(existing.map((o) => o.number));
  let n;
  do {
    n = "ACN-" + (100000 + crypto.randomInt(900000));
  } while (set.has(n));
  return n;
}

function buildOrder(v) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    number: newOrderNumber(store.getOrders()),
    customer: {
      name: v.name,
      phone: v.phone,
      address: v.address,
      city: v.city,
    },
    payMethod: v.payMethod,
    cardLast4: v.cardLast4,
    lines: v.lines,
    coupon: v.coupon,
    subtotal: v.subtotal,
    discount: v.discount,
    shipping: v.shipping,
    total: v.total,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

function stats() {
  const orders = store.getOrders();
  const valid = orders.filter((o) => o.status !== "cancelled");
  const revenue = valid.reduce((s, o) => s + Number(o.total || 0), 0);
  const byStatus = {};
  orders.forEach((o) => {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  });

  // Revenue per day, last 14 days (oldest → newest).
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: d, revenue: 0, orders: 0 });
  }
  const byDay = new Map(days.map((d) => [d.day, d]));
  valid.forEach((o) => {
    const key = String(o.createdAt || "").slice(0, 10);
    const row = byDay.get(key);
    if (row) {
      row.revenue += Number(o.total || 0);
      row.orders += 1;
    }
  });

  // Top products by quantity sold.
  const agg = new Map();
  valid.forEach((o) =>
    (o.lines || []).forEach((l) => {
      const cur = agg.get(l.id) || { id: l.id, name: l.name, qty: 0, revenue: 0 };
      cur.qty += l.qty;
      cur.revenue += l.qty * l.price;
      agg.set(l.id, cur);
    })
  );
  const topProducts = [...agg.values()]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);

  return {
    orders: orders.length,
    revenue,
    avgOrder: valid.length ? Math.round(revenue / valid.length) : 0,
    byStatus,
    revenueByDay: days,
    topProducts,
    newsletter: store.getNewsletter().length,
    sessions: store.getSessions().length,
    products: store.getProducts().length,
    coupons: store.getCoupons().length,
  };
}

module.exports = {
  FREE_SHIP_AT,
  SHIP_COST,
  STATUSES,
  esc,
  findCoupon,
  validateOrder,
  buildOrder,
  stats,
};
