// =====================================================================
// QuickBite — analytics-service seed (MongoDB / DocumentDB)
//
// Analytics stores DAY-GRAINED aggregates only (no raw events). This fills
// the four agg_*_day collections directly, with the same restaurant /
// branch / product ids as seed-core.sql + seed-order.sql, so the analytics
// read endpoints return data for restaurants the rest of the system knows.
//
// Document shapes match analytics-service app/analytics/entity/*.go:
//   agg_restaurant_day  restaurant_id, date, currency, DayCounters
//   agg_branch_day      branch_id, restaurant_id, date, currency, DayCounters
//   agg_product_day     product_id, restaurant_id, date, currency,
//                       units_sold, revenue_sum, orders_count
//   agg_platform_day    date, currency, DayCounters      (one row per currency)
// DayCounters = orders_count, revenue_sum, delivery_ms_sum, delivery_ms_count,
//   rejected_count, rejected_revenue_sum, cancelled_count,
//   cancelled_revenue_sum, payments_count, payments_sum   (money in minor units)
//
// Indexes are NOT created here: the service's EnsureIndexes builds them on
// boot with its own names (creating them here under other names would make
// that fail). Start analytics-service once before or after seeding.
//
// Run (database = the service's MONGO_DB, default quickbite_analytics):
//   mongosh "mongodb://localhost:27017/quickbite_analytics" seed-analytics.js
//   mongosh "mongodb://localhost:27017/quickbite_analytics" --eval "var DAYS=14; var N_RESTAURANTS=20; var N_EG=14" seed-analytics.js
// =====================================================================

// ---- config (override any with: mongosh --eval "var DAYS=30" ...) -----
const CFG = {
  N_RESTAURANTS:  typeof N_RESTAURANTS  !== "undefined" ? N_RESTAURANTS  : 1000,
  N_EG:           typeof N_EG           !== "undefined" ? N_EG           : 700,
  BRANCHES_PER:   3,
  PPR:            typeof PPR            !== "undefined" ? PPR            : 80,   // products/restaurant in core
  PPR_SAMPLED:    typeof PPR_SAMPLED    !== "undefined" ? PPR_SAMPLED    : 20,   // products/restaurant tracked here
  DAYS:           typeof DAYS           !== "undefined" ? DAYS           : 90,
  BATCH:          5000,
};

print(">> seeding analytics db=" + db.getName() + ": restaurants=" + CFG.N_RESTAURANTS +
      " days=" + CFG.DAYS + " sampledProducts/rest=" + CFG.PPR_SAMPLED);

// ---- helpers ----------------------------------------------------------
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function isoDay(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }

// last DAYS calendar days ending today (UTC), as "YYYY-MM-DD" strings.
const days = [];
{
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  for (let i = CFG.DAYS - 1; i >= 0; i--) {
    days.push(isoDay(new Date(base.getTime() - i * 86400000)));
  }
}

function currencyOf(r) { return r <= CFG.N_EG ? "EGP" : "SAR"; }
// small deterministic pseudo-random in [0,1) from an integer key
function rnd(key) { const x = Math.sin(key) * 10000; return x - Math.floor(x); }

function flush(coll, buf) {
  if (buf.length) { db.getCollection(coll).insertMany(buf, { ordered: false }); buf.length = 0; }
}

// One day of counters for `orders` placed at average `avg` minor units.
function dayCounters(orders, avg, deliveryMsAvg) {
  const rejected  = Math.floor(orders * 0.03);
  const cancelled = Math.floor(orders * 0.02);
  const delivered = orders - rejected - cancelled;
  const payments  = Math.floor(delivered * 0.6);
  return {
    orders_count: orders, revenue_sum: orders * avg,
    delivery_ms_sum: delivered * deliveryMsAvg, delivery_ms_count: delivered,
    rejected_count: rejected, rejected_revenue_sum: rejected * avg,
    cancelled_count: cancelled, cancelled_revenue_sum: cancelled * avg,
    payments_count: payments, payments_sum: payments * avg,
  };
}

const now = new Date();

// Fresh start (idempotent re-seed). deleteMany keeps the service's indexes.
["agg_restaurant_day", "agg_branch_day", "agg_product_day", "agg_platform_day"].forEach(function (c) {
  db.getCollection(c).deleteMany({});
});

// ---------------------------------------------------------------------
// 1. agg_restaurant_day + agg_branch_day  (same DayCounters shape)
//    Platform totals are summed from the restaurant rows so all levels agree.
// ---------------------------------------------------------------------
const platform = {}; // "date|currency" -> summed counters
function addPlatform(date, currency, c) {
  const key = date + "|" + currency;
  const p = platform[key] || (platform[key] = { date: date, currency: currency, counters: {} });
  for (const k in c) p.counters[k] = (p.counters[k] || 0) + c[k];
}

let rBuf = [], bBuf = [];
let rCount = 0, bCount = 0;
for (let r = 1; r <= CFG.N_RESTAURANTS; r++) {
  const cur = currencyOf(r);
  for (let di = 0; di < days.length; di++) {
    const date = days[di];

    const rc = dayCounters(
      40 + Math.floor(rnd(r * 31 + di) * 160),        // 40..200 orders
      4000 + Math.floor(rnd(r * 17 + di) * 6000),     // 40.00..100.00 average
      1800000 + Math.floor(rnd(r + di) * 1800000));   // 30..60 min delivery
    rBuf.push(Object.assign({ restaurant_id: r, date: date, currency: cur }, rc, { updated_at: now }));
    addPlatform(date, cur, rc);
    rCount++;
    if (rBuf.length >= CFG.BATCH) flush("agg_restaurant_day", rBuf);

    // branch-level (each branch gets its own volume)
    for (let k = 1; k <= CFG.BRANCHES_PER; k++) {
      const branchId = (r - 1) * CFG.BRANCHES_PER + k;
      const bc = dayCounters(
        12 + Math.floor(rnd(branchId * 13 + di) * 60),
        4000 + Math.floor(rnd(branchId * 7 + di) * 6000),
        1800000 + Math.floor(rnd(branchId + di) * 1800000));
      bBuf.push(Object.assign({ branch_id: branchId, restaurant_id: r, date: date, currency: cur }, bc, { updated_at: now }));
      bCount++;
      if (bBuf.length >= CFG.BATCH) flush("agg_branch_day", bBuf);
    }
  }
}
flush("agg_restaurant_day", rBuf);
flush("agg_branch_day", bBuf);
print("   agg_restaurant_day: " + rCount + "   agg_branch_day: " + bCount);

// ---------------------------------------------------------------------
// 2. agg_product_day  (first PPR_SAMPLED products of each restaurant)
// ---------------------------------------------------------------------
let pBuf = [], pCount = 0;
for (let r = 1; r <= CFG.N_RESTAURANTS; r++) {
  const cur = currencyOf(r);
  for (let s = 1; s <= CFG.PPR_SAMPLED; s++) {
    const productId = (r - 1) * CFG.PPR + s;  // matches seed-core product id formula
    const price = 1500 + (s % 40) * 100;      // matches seed-core branch price
    for (let di = 0; di < days.length; di++) {
      const units = 5 + Math.floor(rnd(productId * 3 + di) * 60);
      pBuf.push({
        product_id: productId, restaurant_id: r, date: days[di], currency: cur,
        units_sold: units, revenue_sum: units * price,
        orders_count: Math.max(1, Math.floor(units / 2)),
        updated_at: now,
      });
      pCount++;
      if (pBuf.length >= CFG.BATCH) flush("agg_product_day", pBuf);
    }
  }
}
flush("agg_product_day", pBuf);
print("   agg_product_day: " + pCount);

// ---------------------------------------------------------------------
// 3. agg_platform_day  (per date x currency, summed from step 1)
// ---------------------------------------------------------------------
const plDocs = Object.keys(platform).map(function (k) {
  const p = platform[k];
  return Object.assign({ date: p.date, currency: p.currency }, p.counters, { updated_at: now });
});
flush("agg_platform_day", plDocs);
print("   agg_platform_day: " + Object.keys(platform).length);

print(">> done analytics");
printjson({
  agg_restaurant_day: db.agg_restaurant_day.countDocuments(),
  agg_branch_day:     db.agg_branch_day.countDocuments(),
  agg_product_day:    db.agg_product_day.countDocuments(),
  agg_platform_day:   db.agg_platform_day.countDocuments(),
});
