# QuickBite — seed data + load test

System-wide: it seeds and drives **all three services** (core, order,
analytics). It lives in the order-service repo because the order path is the
one under test, but the commands below run from the `quickbite` root folder
against the root `docker-compose.yml`.

Three seed scripts (one per datastore) plus a k6 load test that drives the
hot path at the target rate of **~54M requests/day ≈ 625 req/s** with
**~200k orders/day** split across EG and KSA.

```
order-service/loadtest/
  seed-core.sql        # core-service  Postgres (quickbite_core)             — users, restaurants, branches, menus
  seed-order.sql       # order-service Postgres (order_service_eg / _ksa)    — orders, items, payments, balances, earnings
  seed-analytics.js    # analytics-service MongoDB (MONGO_DB, quickbite_analytics) — agg_*_day rollups
  loadtest.js          # k6 load test (local or Grafana Cloud k6)
```

Adapted from the instructor's kit to this codebase's schema:
`customer_addresses.long`, branch `delivery_radius` in **km**, the owner
role looked up by name, and analytics documents shaped like
`analytics-service/app/analytics/entity/*.go` (platform days per currency;
indexes left to the service's `EnsureIndexes`).

## What gets seeded (full scale)

| Store    | Rows |
|----------|------|
| core users | 1,000,000 (1k restaurant owners, 5k delivery agents, ~994k customers; 50k of them have an address and can place orders) |
| core restaurants / branches | 1,000 / 3,000 (700 EG + 300 KSA, 3 branches each) |
| core products / per-branch details | 80,000 / 240,000 (price + big stock so the load test never depletes) |
| order_service_eg | ~1,000,000 orders (+items, transactions, sessions, earnings, balances) |
| order_service_ksa | ~400,000 orders (+ the same children) |
| analytics agg_*_day | ~90k restaurant-days, ~270k branch-days, ~1.8M product-days, ~180 platform-days |

### Deterministic ID contract (the three scripts agree on this)

So the live load test can build valid references with pure arithmetic — no lookups:

- `restaurant r` → id `r`, owner is user id `r`
- branches of `r` → ids `(r-1)*3 + {1,2,3}`
- products of `r` → ids `(r-1)*80 + {1..80}`
- EG restaurants `1..700` (`country_code='eg'`, `EGP`); KSA restaurants `701..1000` (`'ksa'`, `SAR`)
- orderable customers → user ids `6001..56000`, and **their address id == their user id**
- delivery agents → user ids `1001..6000`
- every seeded user's password is `Password123!`

> order-service derives its shard from the branch `country_code`, which is
> why core seeds `'eg'`/`'ksa'`: `normalizeRegion` lowercases and checks
> membership in `REGIONS`.

## Prerequisites

- **Seed into freshly migrated, empty databases.** The seeds insert explicit
  ids (1, 2, 3 …) and then move the sequences, so they collide with existing
  rows. Run migrations first; order partitions are created by the order seed.
- `psql`, `mongosh` and `k6`. None are needed on the host: every command below
  has a Docker form that uses the containers of the root `docker-compose.yml`.

## Seeding — local root stack (`quickbite/docker-compose.yml`)

Start the stack once (it migrates core + every order shard on the way up):

```bash
cd quickbite
docker compose up -d --build
```

Then seed. These pipe each script into the running `postgres` / `mongo`
containers (run from the `quickbite` root folder). Small "smoke" sizes shown — drop
the `-v`/`--eval` overrides for the full scale above.

```bash
# 1. core   (smoke: 2k users, 20 restaurants, 8 products each)
docker compose exec -T postgres psql -U postgres -d quickbite_core -v ON_ERROR_STOP=1 \
  -v n_users=8000 -v n_restaurants=20 -v n_eg_restaurants=14 -v ppr=8 -v n_agents=50 -v n_order_customers=500 \
  -f - < order-service/loadtest/seed-core.sql

# 2. order — once per shard, region-specific vars (must match the core sizes)
docker compose exec -T postgres psql -U postgres -d order_service_eg -v ON_ERROR_STOP=1 \
  -v region=eg -v currency=EGP -v rest_start=1 -v rest_end=14 -v ppr=8 -v n_agents=50 -v n_order_customers=500 \
  -v n_orders=5000 -v p_online=50 -f - < order-service/loadtest/seed-order.sql
docker compose exec -T postgres psql -U postgres -d order_service_ksa -v ON_ERROR_STOP=1 \
  -v region=ksa -v currency=SAR -v rest_start=15 -v rest_end=20 -v ppr=8 -v n_agents=50 -v n_order_customers=500 \
  -v n_orders=2000 -v p_online=0 -f - < order-service/loadtest/seed-order.sql

# 3. analytics
docker compose exec -T mongo mongosh --quiet "mongodb://localhost:27017/quickbite_analytics" \
  --eval "var N_RESTAURANTS=20; var N_EG=14; var PPR=8; var PPR_SAMPLED=4; var DAYS=14" \
  --file /dev/stdin < order-service/loadtest/seed-analytics.js
```

## Seeding — AWS (from a bastion in the VPC)

The data stores are private, so seed from an EC2 bastion in the same VPC
(the deployment guide covers creating it). RDS needs TLS (`sslmode=require`);
DocumentDB needs TLS with the RDS CA bundle and `retryWrites=false`:

```bash
curl -sO https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

PGPASSWORD=... psql "host=<core-rds-endpoint> port=5432 user=<user> dbname=quickbite_core sslmode=require" \
  -v ON_ERROR_STOP=1 -f seed-core.sql
PGPASSWORD=... psql "host=<order-eg-rds-endpoint> port=5432 user=<user> dbname=order_service_eg sslmode=require" \
  -v ON_ERROR_STOP=1 -v region=eg  -v currency=EGP -v rest_start=1   -v rest_end=700  -v n_orders=1000000 -v p_online=50 -f seed-order.sql
PGPASSWORD=... psql "host=<order-ksa-rds-endpoint> port=5432 user=<user> dbname=order_service_ksa sslmode=require" \
  -v ON_ERROR_STOP=1 -v region=ksa -v currency=SAR -v rest_start=701 -v rest_end=1000 -v n_orders=400000  -v p_online=0  -f seed-order.sql
mongosh "mongodb://<user>:<password>@<docdb-endpoint>:27017/quickbite_analytics?tls=true&tlsCAFile=global-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false" \
  seed-analytics.js
```

Keep real endpoints and passwords out of this repo — pass them on the command
line or through environment variables.

## Load test

`ACCESS_SECRET` is **required**: the script mints HS256 access-token cookies
in-script (same shape the services issue), so it must equal the services'
`ACCESS_SECRET`.

### Local smoke run (k6 in Docker, against the root stack)

```bash
# ~7-8 req/s for 30s. host.docker.internal reaches the stack's published ports.
docker run --rm -i grafana/k6:0.54.0 run \
  -e PROFILE=local -e ACCESS_SECRET=<your ACCESS_SECRET> \
  -e CORE_URL=http://host.docker.internal:3000 -e ORDER_URL=http://host.docker.internal:4000 \
  -e N_RESTAURANTS=20 -e N_EG_RESTAURANTS=14 -e PPR=8 -e N_ORDER_CUSTOMERS=500 \
  - < order-service/loadtest/loadtest.js
```

(With k6 installed locally: `k6 run -e PROFILE=local -e ACCESS_SECRET=... loadtest.js`.)

### Full run on Grafana Cloud k6

Grafana Cloud k6 runs the same file on distributed load generators with a
dashboard — no infrastructure to stand up. The targets must be public.

```bash
k6 cloud login --token <YOUR_GRAFANA_CLOUD_K6_TOKEN>
k6 cloud run -e ALB_URL=https://<your-alb-or-domain> -e ACCESS_SECRET=<ACCESS_SECRET> -e DURATION=15m loadtest.js
```

### Traffic mix (sums to ~625 req/s at `RATE_SCALE=1`, the full-profile default)

| Scenario | Endpoint | req/s | Service |
|----------|----------|------:|---------|
| menu_items | `GET /api/branches/:id/products` | 300 | core (hottest) |
| restaurants_list | `GET /api/restaurants` | 90 | core |
| restaurant_detail | `GET /api/restaurants/:id` | 40 | core |
| restaurant_branches | `GET /api/restaurants/:id/branches` | 70 | core |
| nearby | `GET /api/branches/nearby` | 60 | core |
| categories | `GET /api/restaurants/:id/categories` | 30 | core |
| orders_eg | `POST /api/orders` (X-Region: eg) | 1.6 | order EG (~140k/day) |
| orders_sa | `POST /api/orders` (X-Region: ksa) | 0.7 | order KSA (~60k/day) |
| customer_orders_eg | `GET /api/customer/orders` | 22 | order EG |
| customer_orders_sa | `GET /api/customer/orders` | 10 | order KSA |

`orders_eg + orders_sa ≈ 2.3/s ≈ 200k orders/day`. Knobs (all `-e`):
`RATE_SCALE` (scale every rate), `DURATION`, `ORDER_PAYMENT_METHOD`,
`ALB_URL` / `CORE_URL` / `ORDER_URL`, `ACCESS_SECRET`, and the `DATA.*`
dataset sizes (`N_RESTAURANTS`, `N_EG_RESTAURANTS`, `PPR`, `CUST_BASE`,
`N_ORDER_CUSTOMERS`) — these must match what was seeded.

### Notes / decisions

- **Order creation uses COD** (`ORDER_PAYMENT_METHOD=cod`) so the write path is
  self-contained — it still fans out to core (branch lookup, address ownership
  check, product lookup, **stock reservation**) and writes the order, but does
  **not** call the external Kashier test API. `-e ORDER_PAYMENT_METHOD=online`
  (EG only) also exercises Kashier — expect external latency/limits then.
- The browse endpoints are **public** (no auth) — that's the real hot path.
  `GET /branches/:id/products` is cached for 60s, so most menu reads are Redis hits.
- Open-model load: rates are fixed by `constant-arrival-rate`, so if the system
  slows down, in-flight requests pile up (rising p95/p99 and
  `dropped_iterations`) instead of the offered load dropping.
- Thresholds (`http_req_failed < 1%`, `p95 < 800ms`, order `p95 < 1500ms`) are
  starting points — tune to your SLOs.
