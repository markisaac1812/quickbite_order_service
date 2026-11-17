-- =====================================================================
-- QuickBite — core-service seed (single database: quickbite_core)
--
-- Seeds users, restaurants, branches, categories, products, per-branch
-- product details (price/stock), customer addresses and restaurant
-- membership. Requires PostGIS (the restaurant_branches.location column
-- is a generated geography) — the same extension the migrations create.
--
-- Run:
--   psql "host=localhost port=5432 user=postgres password=postgres dbname=quickbite_core" \
--        -v ON_ERROR_STOP=1 -f seed-core.sql
--
-- Deterministic ID layout (so order-service seed + the live load test can
-- compute valid references without lookups):
--   users
--     1 .. N_RESTAURANTS                         -> restaurant owners (restaurant_user)
--     AGENT_BASE+1 .. AGENT_BASE+N_AGENTS        -> delivery agents
--     CUST_BASE+1  .. N_USERS                    -> customers
--   restaurant r  -> id r, owner_id r
--     branches    -> ids (r-1)*3 + {1,2,3}
--     categories  -> ids (r-1)*N_CATEGORIES + {1..N_CATEGORIES}
--     products    -> ids (r-1)*PPR + {1..PPR}
--   EG restaurants : 1 .. N_EG_RESTAURANTS  (country_code 'eg', currency EGP)
--   KSA restaurants: N_EG_RESTAURANTS+1 .. N_RESTAURANTS ('ksa', SAR)
--   orderable customers (one address each, address.id == user.id):
--     CUST_BASE+1 .. CUST_BASE+N_ORDER_CUSTOMERS
--
-- All seed users share the password "Password123!" (bcrypt cost 10), so
-- they can also log in normally if the load test prefers real logins.
-- =====================================================================

\set ON_ERROR_STOP on

\if :{?n_users}            \else \set n_users            1000000 \endif
\if :{?n_restaurants}      \else \set n_restaurants      1000    \endif
\if :{?n_eg_restaurants}   \else \set n_eg_restaurants   700     \endif
\if :{?n_categories}       \else \set n_categories       4       \endif
\if :{?ppr}                \else \set ppr                80      \endif   -- products per restaurant
\if :{?stock}              \else \set stock              1000000 \endif   -- per branch/product (big so load test never depletes)
\if :{?agent_base}         \else \set agent_base         1000    \endif
\if :{?n_agents}           \else \set n_agents           5000    \endif
\if :{?cust_base}          \else \set cust_base          6000    \endif
\if :{?n_order_customers}  \else \set n_order_customers  50000   \endif

\set pw_hash '$2b$10$BmMmTUuSwb6EBQvBGH/9Iu3xympWfaJ1QQttHtplTvQcAxwbP5zBG'

\echo '>> seeding core: users=':n_users' restaurants=':n_restaurants' products/rest=':ppr

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------
-- 1. Users.  Bands: owners | agents | customers (see header).
-- ---------------------------------------------------------------------
INSERT INTO users (id, email, phone, name, password_hash, system_role, created_at, updated_at)
SELECT
    u                                                  AS id,
    'user' || u || '@seed.test'                        AS email,
    '+2' || lpad(u::text, 12, '0')                     AS phone,
    'Seed User ' || u                                  AS name,
    :'pw_hash'                                          AS password_hash,
    CASE
        WHEN u <= :n_restaurants                                       THEN 'restaurant_user'
        WHEN u >  :agent_base AND u <= :agent_base + :n_agents         THEN 'delivery_agent'
        ELSE 'customer'
    END                                                AS system_role,
    now(), now()
FROM generate_series(1, :n_users) AS u;

SELECT setval(pg_get_serial_sequence('users','id'), :n_users + 1, false);

-- ---------------------------------------------------------------------
-- 2. Restaurants — owner_id == id. First N_EG are EG, rest KSA.
-- ---------------------------------------------------------------------
INSERT INTO restaurants (id, owner_id, name, logo_url, status, primary_country, created_at, updated_at, status_updated_at)
SELECT
    r, r,
    'Seed Restaurant ' || r,
    'https://cdn.seed.test/logo/' || r || '.png',
    'active',
    CASE WHEN r <= :n_eg_restaurants THEN 'eg' ELSE 'ksa' END,
    now(), now(), now()
FROM generate_series(1, :n_restaurants) AS r;

SELECT setval(pg_get_serial_sequence('restaurants','id'), :n_restaurants + 1, false);

-- ---------------------------------------------------------------------
-- 3. Branches — 3 per restaurant, ids (r-1)*3 + {1,2,3}.
--    country_code / currency must match the order-service shard keys
--    ('eg'/'ksa'), because order-service derives its region from this.
-- ---------------------------------------------------------------------
INSERT INTO restaurant_branches (
    id, restaurant_id, country_code, address_text, label, lat, lng,
    is_active, opens_at, closes_at, accept_orders, created_at, updated_at,
    delivery_radius, currency, commission, delivery_fee
)
SELECT
    (r - 1) * 3 + k                                       AS id,
    r                                                     AS restaurant_id,
    CASE WHEN r <= :n_eg_restaurants THEN 'eg' ELSE 'ksa' END AS country_code,
    'Seed St ' || r || ', Branch ' || k                   AS address_text,
    'Branch ' || k || ' of R' || r                        AS label,
    -- 2-D spread over [30.0,30.4) x [31.0,31.4) (Cairo). lat & lng use
    -- different coprime multipliers of r so branches fill the box the
    -- load test's `nearby` samples (NOT a diagonal line) — so nearby
    -- actually returns branches.
    (30.0 + ((r * 13)  % 500) * 0.0008)::decimal(9,6)     AS lat,
    (31.0 + ((r * 137) % 500) * 0.0008)::decimal(9,6)     AS lng,
    true                                                  AS is_active,
    '00:00:00'::time, '23:59:00'::time,
    true                                                  AS accept_orders,
    now(), now(),
    5                                                     AS delivery_radius, -- km (nearby query uses radius * 1000 m)
    CASE WHEN r <= :n_eg_restaurants THEN 'EGP' ELSE 'SAR' END AS currency,
    12                                                    AS commission,      -- percent
    (1000 + (r % 5) * 500)                                AS delivery_fee     -- 10.00 .. 30.00 minor units
FROM generate_series(1, :n_restaurants) AS r
CROSS JOIN generate_series(1, 3) AS k;

SELECT setval(pg_get_serial_sequence('restaurant_branches','id'), :n_restaurants * 3 + 1, false);

-- ---------------------------------------------------------------------
-- 4. Categories — N_CATEGORIES per restaurant, ids (r-1)*C + c.
-- ---------------------------------------------------------------------
INSERT INTO product_categories (id, restaurant_id, name, created_at, updated_at)
SELECT
    (r - 1) * :n_categories + c                AS id,
    r                                          AS restaurant_id,
    'Category ' || c                           AS name,
    now(), now()
FROM generate_series(1, :n_restaurants) AS r
CROSS JOIN generate_series(1, :n_categories) AS c;

SELECT setval(pg_get_serial_sequence('product_categories','id'), :n_restaurants * :n_categories + 1, false);

-- ---------------------------------------------------------------------
-- 5. Products — PPR per restaurant, ids (r-1)*PPR + p.
--    Disable the auto-fan-out trigger; we insert product_branch_details
--    ourselves (faster + deterministic price/stock).
-- ---------------------------------------------------------------------
ALTER TABLE products DISABLE TRIGGER trg_product_after_insert;

INSERT INTO products (id, name, description, image_url, restaurant_id, category_id, created_at, updated_at)
SELECT
    (r - 1) * :ppr + p                                     AS id,
    'Seed Product ' || ((r - 1) * :ppr + p)                AS name,
    'Tasty seed item #' || p || ' of restaurant ' || r     AS description,
    'https://cdn.seed.test/p/' || ((r - 1) * :ppr + p) || '.png' AS image_url,
    r                                                      AS restaurant_id,
    (r - 1) * :n_categories + 1 + (p % :n_categories)      AS category_id,
    now(), now()
FROM generate_series(1, :n_restaurants) AS r
CROSS JOIN generate_series(1, :ppr) AS p;

SELECT setval(pg_get_serial_sequence('products','id'), :n_restaurants * :ppr + 1, false);

ALTER TABLE products ENABLE TRIGGER trg_product_after_insert;

-- ---------------------------------------------------------------------
-- 6. Per-branch product details (price / stock / availability).
--    One row per (branch of r) x (product of r). ~ N*3*PPR rows.
-- ---------------------------------------------------------------------
INSERT INTO product_branch_details (branch_id, product_id, price, stock, is_available)
SELECT
    (r - 1) * 3 + k                          AS branch_id,
    (r - 1) * :ppr + p                        AS product_id,
    (1500 + (p % 40) * 100)                   AS price,    -- 15.00 .. 54.00 minor units
    :stock                                    AS stock,
    true                                      AS is_available
FROM generate_series(1, :n_restaurants) AS r
CROSS JOIN generate_series(1, 3)     AS k
CROSS JOIN generate_series(1, :ppr)  AS p;

-- ---------------------------------------------------------------------
-- 7. Customer addresses — one per orderable customer, address.id == user.id.
-- ---------------------------------------------------------------------
INSERT INTO customer_addresses (id, user_id, label, country, city, street, building, apartment_number, type, lat, long, is_default)
SELECT
    u                                          AS id,
    u                                          AS user_id,
    'Home',
    'Egypt',
    'Cairo',
    'Seed Street ' || u,
    (u % 50)::text,
    (u % 12)::text,
    'home',
    (30.0 + (u % 1000) * 0.0005)::decimal(10,7),
    (31.0 + (u % 1000) * 0.0005)::decimal(10,7),
    true
FROM generate_series(:cust_base + 1, :cust_base + :n_order_customers) AS u;

SELECT setval(pg_get_serial_sequence('customer_addresses','id'), :cust_base + :n_order_customers + 1, false);

-- ---------------------------------------------------------------------
-- 8. Restaurant membership — each owner is an 'owner' member of their
--    restaurant (role looked up by name), attached to all 3 of its branches.
-- ---------------------------------------------------------------------
INSERT INTO restaurant_members (id, restaurant_id, user_id, role_id, status, created_at, updated_at)
SELECT r, r, r, (SELECT id FROM roles WHERE name = 'owner'), 'active', now(), now()
FROM generate_series(1, :n_restaurants) AS r;

SELECT setval(pg_get_serial_sequence('restaurant_members','id'), :n_restaurants + 1, false);

INSERT INTO member_branches (member_id, branch_id, created_at)
SELECT r AS member_id, (r - 1) * 3 + k AS branch_id, now()
FROM generate_series(1, :n_restaurants) AS r
CROSS JOIN generate_series(1, 3) AS k;

ANALYZE users;
ANALYZE restaurants;
ANALYZE restaurant_branches;
ANALYZE products;
ANALYZE product_branch_details;

\echo '>> done core'
SELECT
    (SELECT count(*) FROM users)                   AS users,
    (SELECT count(*) FROM restaurants)             AS restaurants,
    (SELECT count(*) FROM restaurant_branches)     AS branches,
    (SELECT count(*) FROM product_categories)      AS categories,
    (SELECT count(*) FROM products)                AS products,
    (SELECT count(*) FROM product_branch_details)  AS product_branch_details,
    (SELECT count(*) FROM customer_addresses)      AS addresses,
    (SELECT count(*) FROM restaurant_members)      AS members;
