import {dbFor} from "../../src/lib/knex/knex";
import {Cluster} from "../../src/lib/knex/types";
import {env} from "../../src/lib/config/env";

// Migration bookkeeping + migration-seeded lookups (payment_providers) survive
// truncation so the test shard keeps looking like a freshly migrated one.
const PRESERVED_TABLES = new Set(["knex_migrations", "knex_migrations_lock", "payment_providers"]);

/**
 * Safety net: if .env.test ever failed to load, env.ts would fall back to the
 * dev `.env` — and truncateAll would wipe dev data. Refuse anything that is
 * not explicitly a test database.
 */
export function assertTestDatabase(name: string): void {
    if (!name.endsWith("_test")) {
        throw new Error(`Refusing to touch non-test database "${name}" (name must end in "_test")`);
    }
}

export async function truncateAll(region: string, cluster: Cluster = "hot"): Promise<void> {
    const shards = cluster === "hot" ? env.hotShards : env.archiveShards;
    assertTestDatabase(shards[region].name);
    const conn = dbFor(region, cluster);
    const result = await conn.raw<{rows: {table_name: string}[]}>(
        `SELECT tablename AS table_name
         FROM pg_catalog.pg_tables
         WHERE schemaname = 'public'`,
    );
    const tableNames = result.rows
        .map((r) => r.table_name)
        .filter((t) => !PRESERVED_TABLES.has(t))
        .map((t) => `"${t}"`)
        .join(", ");
    if (tableNames) await conn.raw(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`);
}
