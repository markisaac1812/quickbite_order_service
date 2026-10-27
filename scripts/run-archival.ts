/**
 * Runs one archival pass now (same code path as the nightly worker job).
 *
 *   npx tsx scripts/run-archival.ts              # all regions
 *   REGION=eg npx tsx scripts/run-archival.ts    # single region
 *
 * Safe to run while the worker is up — the per-region Redis lock makes a
 * concurrent run skip instead of double-moving.
 */
import "reflect-metadata";
import {env} from "../src/lib/config/env";
import {archiveRegion} from "../src/lib/jobs/archival.worker";
import {destroyAll} from "../src/lib/knex/knex";

async function main() {
    const requested = process.env.REGION;
    const regions = requested ? [requested] : env.regions;
    for (const region of regions) {
        const stats = await archiveRegion(region);
        console.log(JSON.stringify(stats));
    }
    await destroyAll();
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
