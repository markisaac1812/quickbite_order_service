import type {Knex} from "knex";
import {env} from "../config/env";

/**
 * Builds a knex config for the region+cluster identified by env vars.
 *   REGION=eg|ksa|...   (required — no default so migrations can never silently hit the wrong shard)
 *   CLUSTER=hot|archive (defaults to "hot")
 *
 * Drives `npm run migrate`, `migrate:rollback`, etc. The per-process shard
 * connections used by the running app come from `knex.ts`, not this file.
 */
const region = process.env.REGION;
if (!region) {
    throw new Error("REGION env var is required (e.g. `REGION=eg npm run migrate`)");
}

const cluster = (process.env.CLUSTER ?? "hot") as "hot" | "archive";
const shards = cluster === "hot" ? env.hotShards : env.archiveShards;
const shard = shards[region];
if (!shard) {
    throw new Error(`No ${cluster} shard configured for region "${region}"`);
}

const config: Knex.Config = {
    client: "pg",
    connection: {
        host: shard.host,
        port: shard.port,
        user: shard.username,
        password: shard.password,
        database: shard.name,
        // RDS requires TLS (see lib/knex/shards.ts).
        ssl: env.db.ssl ? {rejectUnauthorized: false} : false,
    },
    pool: {min: 0, max: env.db.poolMax},
    migrations: {
        directory: env.db.migrationDirectory,
        extension: env.db.migrationExtension,
    },
};

export default config;
