import "../setup-env"; // first: env.ts must see .env.test
import {Client} from "pg";
import {env, ShardConfig} from "../../src/lib/config/env";
import {db, dbArchive} from "../../src/lib/knex/knex";
import {assertTestDatabase} from "../helpers/db";

/**
 * Runs once in Jest's parent process before any integration file. For every
 * region, on both the hot and the archive cluster:
 *   1. creates the test database if it doesn't exist yet;
 *   2. migrates it to latest (the archive cluster runs the same migrations).
 * Migrations read REGION (payment_providers seed), so it's set per shard.
 */
export default async function globalSetup(): Promise<void> {
    for (const region of env.regions) {
        process.env.REGION = region;
        for (const [shard, conn] of [[env.hotShards[region], db(region)], [env.archiveShards[region], dbArchive(region)]] as const) {
            assertTestDatabase(shard.name);
            await ensureDatabase(shard);
            await conn.migrate.latest();
        }
    }
    console.log(`\nIntegration setup: migrated hot + archive test shards [${env.regions.join(", ")}]`);
}

async function ensureDatabase(shard: ShardConfig): Promise<void> {
    const client = new Client({
        host: shard.host,
        port: shard.port,
        user: shard.username,
        password: shard.password,
        database: "postgres",
    });
    await client.connect();
    try {
        const {rowCount} = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [shard.name]);
        if (rowCount === 0) await client.query(`CREATE DATABASE "${shard.name}"`);
    } finally {
        await client.end();
    }
}
