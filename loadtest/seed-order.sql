-- =====================================================================
-- QuickBite — order-service seed (ONE SHARD per run)
--
-- The order-service is sharded by region (one Postgres DB per country):
--   order_service_eg   (region 'eg',  currency EGP)
--   order_service_ksa  (region 'ksa', currency SAR)
--
-- Run this file ONCE PER SHARD, pointing -d at that shard's database and
-- passing the region-specific variables. The seed/seed.ps1 / seed.sh
-- runners do this for you. To run by hand:
--
--   psql "host=localhost port=5432 user=postgres password=postgres dbname=order_service_eg" \
--        -v ON_ERROR_STOP=1 \
--        -v region=eg -v currency=EGP \
--        -v rest_start=1 -v rest_end=700 \
--        -v n_orders=1000000 -v p_online=50 \
--        -f seed-order.sql
--
--   psql "...dbname=order_service_ksa" \
--        -v ON_ERROR_STOP=1 \
--        -v region=ksa -v currency=SAR \
--        -v rest_start=701 -v rest_end=1000 \
--        -v n_orders=400000 -v p_online=0 \
--        -f seed-order.sql
--
-- IDs are kept consistent with seed-core.sql so live POST /orders works:
--   restaurant r  -> owner user id = r,  branches (r-1)*3 + {1,2,3}
--   products of r -> ids (r-1)*PPR + {1..PPR}   (PPR default 80)
--   orderable customers -> user ids CUST_BASE+1 .. CUST_BASE+N_ORDER_CUSTOMERS
--   delivery agents      -> user ids AGENT_BASE+1 .. AGENT_BASE+N_AGENTS
-- =====================================================================

\set ON_ERROR_STOP on

-- ---- defaults (only applied if not supplied with -v) -----------------
\if :{?region}            \else \set region            'eg'    \endif
\if :{?currency}          \else \set currency          'EGP'   \endif
\if :{?rest_start}        \else \set rest_start         1      \endif
\if :{?rest_end}          \else \set rest_end           700    \endif
\if :{?n_orders}          \else \set n_orders           1000000 \endif
\if :{?p_online}          \else \set p_online           50     \endif   -- % of orders paid online (rest = cod)
\if :{?days}              \else \set days               30     \endif   -- spread created_at over the last N days
\if :{?ppr}               \else \set ppr                80     \endif   -- products per restaurant (must match seed-core)
\if :{?cust_base}         \else \set cust_base          6000   \endif
\if :{?n_order_customers} \else \set n_order_customers  50000  \endif
\if :{?agent_base}        \else \set agent_base         1000   \endif
\if :{?n_agents}          \else \set n_agents           5000   \endif

\echo '>> seeding shard region=':region' currency=':currency' orders=':n_orders

-- pgcrypto gives us gen_random_uuid() on PG < 13; PG16 has it built in but
-- this is harmless if already present.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Monthly partitions for the orders table.
--    The orders table is RANGE-partitioned on created_at (monthly). The
--    create-partitions script only builds FUTURE months, so historical
--    seed rows have nowhere to land. Build a rolling window: 14 months
--    back .. 1 month ahead. (Keep :days <= ~390 to stay inside it.)
-- ---------------------------------------------------------------------
DO $$
DECLARE
    i   int;
    lo  date;
    hi  date;
    pname text;
BEGIN
    FOR i IN -14..1 LOOP
        lo := (date_trunc('month', now()) + make_interval(months => i))::date;
        hi := (date_trunc('month', now()) + make_interval(months => i + 1))::date;
        pname := 'orders_' || to_char(lo, 'YYYY_MM');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF orders FOR VALUES FROM (%L) TO (%L)',
            pname, lo, hi);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 2. Orders.  One row per generate_series tick. id is set explicitly so
--    child rows (items, transactions, earnings, sessions) can reference
--    it without a round-trip. created_at is spread across the last N days.
--
--    status mix (deterministic by id % 20):
--      0..13 delivered (70%) | 14 cancelled | 15 rejected
--      16 preparing | 17 ready | 18 accepted | 19 placed
--    payment_method: first :p_online % online, rest cod.
-- ---------------------------------------------------------------------
INSERT INTO orders (
    id, region, public_id, country_code,
    restaurant_id, restaurant_owner_id, branch_id, customer_id, customer_address_id,
    delivery_lat, delivery_lng, delivery_address_text_snapshot,
    branch_lat, branch_lng,
    status, subtotal, delivery_fee, service_fee, total, commission, currency,
    payment_method, delivery_agent_id,
    created_at, updated_at, accepted_at, ready_at, assigned_at, picked_at, delivered_at, cancelled_at
)
SELECT
    s                                                                       AS id,
    :'region'                                                               AS region,
    gen_random_uuid()                                                       AS public_id,
    :'region'                                                               AS country_code,
    r.restaurant_id,
    r.restaurant_id                                                         AS restaurant_owner_id, -- owner user id == restaurant id
    (r.restaurant_id - 1) * 3 + 1 + (s % 3)                                 AS branch_id,
    :cust_base + 1 + (s % :n_order_customers)                               AS customer_id,
    :cust_base + 1 + (s % :n_order_customers)                               AS customer_address_id, -- addr id == user id in seed-core
    (30.0 + (s % 1000) * 0.0005)::decimal(10,7)                             AS delivery_lat,
    (31.0 + (s % 1000) * 0.0005)::decimal(10,7)                             AS delivery_lng,
    'Seed address ' || s                                                    AS delivery_address_text_snapshot,
    (30.0 + (r.restaurant_id % 500) * 0.0008)::decimal(10,7)               AS branch_lat,
    (31.0 + (r.restaurant_id % 500) * 0.0008)::decimal(10,7)               AS branch_lng,
    (ARRAY['delivered','delivered','delivered','delivered','delivered','delivered','delivered',
           'delivered','delivered','delivered','delivered','delivered','delivered','delivered',
           'cancelled','rejected','preparing','ready','accepted','placed'])[1 + (s % 20)] AS status,
    sub.subtotal,
    sub.delivery_fee,
    1000                                                                    AS service_fee,
    sub.subtotal + sub.delivery_fee + 1000                                  AS total,
    (sub.subtotal * 12 / 100)                                               AS commission,
    :'currency'                                                             AS currency,
    CASE WHEN (s % 100) < :p_online THEN 'online' ELSE 'cod' END            AS payment_method,
    CASE WHEN (s % 20) < 14 THEN :agent_base + 1 + (s % :n_agents) END      AS delivery_agent_id,
    ts.created_at,
    ts.created_at                                                           AS updated_at,
    CASE WHEN (s % 20) <> 19 THEN ts.created_at + interval '2 min' END      AS accepted_at,
    CASE WHEN (s % 20) < 18 THEN ts.created_at + interval '18 min' END      AS ready_at,
    CASE WHEN (s % 20) < 14 THEN ts.created_at + interval '20 min' END      AS assigned_at,
    CASE WHEN (s % 20) < 14 THEN ts.created_at + interval '25 min' END      AS picked_at,
    CASE WHEN (s % 20) < 14 THEN ts.created_at + interval '48 min' END      AS delivered_at,
    CASE WHEN (s % 20) = 14 THEN ts.created_at + interval '5 min'  END      AS cancelled_at
FROM generate_series(1, :n_orders) AS s
CROSS JOIN LATERAL (
    SELECT (:rest_start + (s % (:rest_end - :rest_start + 1)))::bigint AS restaurant_id
) AS r
CROSS JOIN LATERAL (
    SELECT (now() - (random() * :days * interval '1 day')) AS created_at
) AS ts
CROSS JOIN LATERAL (
    SELECT
        (3000 + (s % 47) * 250)::int AS subtotal,     -- 30.00 .. ~145.00
        (1000 + (s % 5) * 500)::int  AS delivery_fee  -- 10.00 .. 30.00
) AS sub;

SELECT setval(pg_get_serial_sequence('orders', 'id'), :n_orders + 1, false);

-- ---------------------------------------------------------------------
-- 3. Order items — 3 lines per order, products drawn from that order's
--    restaurant range: (restaurant_id-1)*PPR + 1 .. restaurant_id*PPR.
-- ---------------------------------------------------------------------
INSERT INTO order_items (
    region, order_id, product_id, quantity, unit_price_snapshot, name_snapshot, image_url_snapshot, line_total, created_at
)
SELECT
    :'region'                                                              AS region,
    o.id                                                                   AS order_id,
    (o.restaurant_id - 1) * :ppr + 1 + ((o.id * 3 + k) % :ppr)             AS product_id,
    (1 + (k % 3))                                                          AS quantity,
    (1500 + ((o.id + k) % 40) * 100)                                       AS unit_price_snapshot,
    'Seed product ' || ((o.id * 3 + k) % :ppr + 1)                         AS name_snapshot,
    NULL                                                                   AS image_url_snapshot,
    (1 + (k % 3)) * (1500 + ((o.id + k) % 40) * 100)                       AS line_total,
    o.created_at
FROM orders o
CROSS JOIN generate_series(0, 2) AS k;

-- ---------------------------------------------------------------------
-- 4. Transactions — one 'charge' per order (succeeded). Direction is
--    encoded by src/dst account ids (customer -> restaurant owner).
-- ---------------------------------------------------------------------
INSERT INTO transactions (
    region, order_id, transaction_type, method, provider_id, provider_reference_id,
    status, amount, currency, src_acc_id, dst_acc_id, created_at, updated_at
)
SELECT
    :'region',
    o.id,
    'charge',
    CASE WHEN o.payment_method = 'online' THEN 'online' ELSE 'cod' END,
    CASE WHEN o.payment_method = 'online' THEN 1 ELSE NULL END,
    CASE WHEN o.payment_method = 'online' THEN 'seed-ref-' || :'region' || '-' || o.id ELSE NULL END,
    CASE WHEN o.status IN ('rejected','cancelled') THEN 'failed' ELSE 'succeeded' END,
    o.total,
    :'currency',
    o.customer_id,
    o.restaurant_owner_id,
    o.created_at,
    o.created_at
FROM orders o;

-- ---------------------------------------------------------------------
-- 5. Payment sessions — only for online orders.
-- ---------------------------------------------------------------------
INSERT INTO payment_sessions (
    region, order_id, provider_id, provider_session_id, redirect_url,
    amount, currency, status, raw_init_payload, created_at, updated_at
)
SELECT
    :'region',
    o.id,
    1,
    'seed-sess-' || :'region' || '-' || o.id,
    'https://test-pay.kashier.io/?session=seed-' || o.id,
    o.total,
    :'currency',
    CASE WHEN o.status IN ('rejected','cancelled') THEN 'failed' ELSE 'captured' END,
    '{"seed":true}'::jsonb,
    o.created_at,
    o.created_at
FROM orders o
WHERE o.payment_method = 'online';

-- ---------------------------------------------------------------------
-- 6. Agent earnings — one row per delivered order (unique on order_id).
--    Agent keeps 80% of the delivery fee.
-- ---------------------------------------------------------------------
INSERT INTO agent_earnings (region, agent_id, order_id, amount, currency, earned_at)
SELECT
    :'region',
    o.delivery_agent_id,
    o.id,
    (o.delivery_fee * 80 / 100),
    :'currency',
    COALESCE(o.delivered_at, o.created_at)
FROM orders o
WHERE o.status = 'delivered' AND o.delivery_agent_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 7. Restaurant balances — running balance per restaurant in this shard.
--    PK is (restaurant_id, currency).
-- ---------------------------------------------------------------------
INSERT INTO restaurant_balances (restaurant_id, region, currency, balance, updated_at)
SELECT
    rid                                  AS restaurant_id,
    :'region',
    :'currency',
    (50000 + (rid % 100) * 1373)::int    AS balance,    -- 500.00 .. ~1860.00
    now()
FROM generate_series(:rest_start, :rest_end) AS rid
ON CONFLICT (restaurant_id, currency) DO NOTHING;

ANALYZE orders;
ANALYZE order_items;
ANALYZE transactions;

\echo '>> done shard region=':region
SELECT
    (SELECT count(*) FROM orders)             AS orders,
    (SELECT count(*) FROM order_items)        AS order_items,
    (SELECT count(*) FROM transactions)       AS transactions,
    (SELECT count(*) FROM payment_sessions)   AS payment_sessions,
    (SELECT count(*) FROM agent_earnings)     AS agent_earnings,
    (SELECT count(*) FROM restaurant_balances) AS balances;
