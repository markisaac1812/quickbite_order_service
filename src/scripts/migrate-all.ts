/**
 * Migrates every configured region, hot and archive cluster (same schema).
 *
 *   npm run migrate:all                     # dev: TypeScript migrations via tsx
 *   npm run migrate:all:prod                # image: compiled dist/migrations
 *   CLUSTER=hot npm run migrate:all         # only one cluster
 *
 * Lives under src/ so it is compiled into dist/ and can run inside the
 * production image (no tsx / ts-node there) — e.g. as the one-off
 * `order-migrate` ECS task before a deploy. Exits non-zero on the first
 * failure so the deploy stops before rolling the services.
 */
import "reflect-metadata";
import {env} from "../lib/config/env";
import {db, dbArchive, destroyAll} from "../lib/knex/knex";
import {logger} from "../lib/logger/logger";

type Cluster = "hot" | "archive";

function clustersFromEnv(): Cluster[] {
    const raw = (process.env.CLUSTER ?? "all").toLowerCase();
    if (raw === "all") return ["hot", "archive"];
    if (raw === "hot" || raw === "archive") return [raw];
    throw new Error(`CLUSTER must be hot, archive or all (got "${raw}")`);
}

async function main(): Promise<void> {
    for (const region of env.regions) {
        // 20260506000010_create_payment_providers seeds per region from REGION.
        process.env.REGION = region;
        for (const cluster of clustersFromEnv()) {
            const conn = cluster === "hot" ? db(region) : dbArchive(region);
            const [batch, applied] = await conn.migrate.latest();
            logger.info("migrations applied", {region, cluster, batch, applied: applied.length, files: applied});
        }
    }
}

main()
    .then(async () => {
        await destroyAll();
        process.exit(0);
    })
    .catch(async (err) => {
        logger.error("migrate:all failed", {error: (err as Error).message});
        await destroyAll().catch(() => undefined);
        process.exit(1);
    });
