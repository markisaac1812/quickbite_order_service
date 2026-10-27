import {randomUUID} from "crypto";
import {Knex} from "knex";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {db, dbArchive, archiveCutoff} from "../knex/knex";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {register} from "./job-registry";
import {ArchivalRunStats, ArchivedTable, ArchiveRow, OrderChildTable, TableColumn} from "./job.types";
import {archiveCopyVerificationError, archiveSchemaMismatchError} from "./errors";
import {
    listTableColumns,
    lockArchivableOrders,
    selectRowsByOrderIds,
    lockWebhookEventsBefore,
    insertRowsIgnoringConflicts,
    countRowsByIds,
    deleteRowsByIds,
    deleteOrdersByIds,
} from "./archival.repo";

/**
 * Nightly cold archival: moves rows created before the start of the current
 * UTC year from the hot cluster to the archive cluster, per region.
 *
 * Unit of work is a batch of ORDERS, not a batch of rows per table: each
 * order travels together with its items, transactions, payment sessions and
 * agent earning, so an archived order is always readable as a whole from one
 * cluster. (A per-table `created_at` cut would split e.g. a Dec-31 order from
 * the earning booked when it was delivered on Jan-1.)
 *
 * Only terminal orders move. A prior-year order still in flight stays hot
 * until it finishes, so its next status transition never hits a missing row.
 *
 * payment_webhook_events has no order_id; it is moved separately by
 * received_at. Order-less ledger rows (payouts) and restaurant_balances are
 * NOT archived — finance needs a continuous ledger on the hot cluster.
 */

const TERMINAL_ORDER_STATUSES = ["delivered", "cancelled", "rejected"] as const;

// Children before parent (FK-safe order from implementation-plan Phase 5).
const ORDER_CHILD_TABLES: readonly OrderChildTable[] = ["agent_earnings", "payment_sessions", "transactions", "order_items"];

const ALL_TABLES: readonly ArchivedTable[] = [...ORDER_CHILD_TABLES, "orders", "payment_webhook_events"];

function lockKey(region: string): string {
    return `archival:${region}:lock`;
}

function emptyStats(region: string): ArchivalRunStats {
    return {
        region,
        batches: 0,
        moved: {orders: 0, order_items: 0, transactions: 0, payment_sessions: 0, agent_earnings: 0, payment_webhook_events: 0},
        total: 0,
        stoppedEarly: false,
        ms: 0,
    };
}

/**
 * Run one archival pass for a region. Safe to call concurrently from several
 * processes (Redis lock) and safe to re-run after a crash (ON CONFLICT DO
 * NOTHING on archive + verify-before-delete on hot).
 */
export async function archiveRegion(region: string): Promise<ArchivalRunStats> {
    const cache = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
    const started = Date.now();
    const stats = emptyStats(region);

    // TTL outlives the max runtime so a crashed run can't block the next night forever.
    const lockTtlSec = env.archival.maxRuntimeMin * 60 + 300;
    const acquired = await cache.trySet(lockKey(region), randomUUID(), lockTtlSec);
    if (!acquired) {
        logger.info("archival skipped (lock held by another process)", {region});
        stats.skipped = "lock-held";
        return stats;
    }

    try {
        const hot = db(region);
        const archive = dbArchive(region);
        const cutoff = archiveCutoff();
        const deadline = started + env.archival.maxRuntimeMin * 60_000;
        const columns = await loadVerifiedColumns(hot, archive);

        let ordersDrained = false;
        while (Date.now() < deadline) {
            const moved = await moveOrderBatch(region, hot, archive, cutoff, columns, stats);
            if (moved === 0) {
                ordersDrained = true;
                break;
            }
        }

        let eventsDrained = false;
        while (ordersDrained && Date.now() < deadline) {
            const moved = await moveWebhookEventBatch(region, hot, archive, cutoff, columns, stats);
            if (moved === 0) {
                eventsDrained = true;
                break;
            }
        }

        stats.stoppedEarly = !(ordersDrained && eventsDrained);
        stats.total = Object.values(stats.moved).reduce((a, b) => a + b, 0);
        stats.ms = Date.now() - started;
        logger.info("archival.run.done", {
            region,
            moved: stats.total,
            ...stats.moved,
            batches: stats.batches,
            stoppedEarly: stats.stoppedEarly,
            cutoff: cutoff.toISOString(),
            ms: stats.ms,
        });
        return stats;
    } finally {
        await cache.del(lockKey(region));
    }
}

/**
 * Reads every archived table's columns from hot once per run and asserts the
 * archive has all of them. Aborts the run (before touching any row) if the
 * archive cluster is behind on migrations.
 */
async function loadVerifiedColumns(hot: Knex, archive: Knex): Promise<Map<ArchivedTable, TableColumn[]>> {
    const out = new Map<ArchivedTable, TableColumn[]>();
    for (const table of ALL_TABLES) {
        const [hotCols, archiveCols] = await Promise.all([listTableColumns(table, hot), listTableColumns(table, archive)]);
        const archiveNames = new Set(archiveCols.map((c) => c.name));
        const missing = hotCols.filter((c) => !archiveNames.has(c.name)).map((c) => c.name);
        if (missing.length > 0) throw archiveSchemaMismatchError(table, missing);
        out.set(table, hotCols);
    }
    return out;
}

/** One hot trx + one archive trx for up to ARCHIVAL_BATCH_SIZE orders. Returns orders moved. */
async function moveOrderBatch(
    region: string,
    hot: Knex,
    archive: Knex,
    cutoff: Date,
    columns: Map<ArchivedTable, TableColumn[]>,
    stats: ArchivalRunStats,
): Promise<number> {
    const t0 = Date.now();
    const hotTrx = await hot.transaction();
    const archiveTrx = await archive.transaction();
    try {
        const orderCols = columns.get("orders")!;
        const orders = await lockArchivableOrders(orderCols.map((c) => c.name), cutoff, TERMINAL_ORDER_STATUSES, env.archival.batchSize, hotTrx);
        if (orders.length === 0) {
            await archiveTrx.rollback();
            await hotTrx.rollback();
            return 0;
        }
        const orderIds = orders.map((o) => o.id);

        // Copy children first, then the parent. Each copy is verified on the
        // archive side (inside its trx) before anything is deleted from hot.
        const childIds = new Map<OrderChildTable, unknown[]>();
        const batchMoved: Partial<Record<ArchivedTable, number>> = {};
        for (const table of ORDER_CHILD_TABLES) {
            const cols = columns.get(table)!;
            const rows = await selectRowsByOrderIds(table, cols.map((c) => c.name), orderIds, hotTrx);
            await copyAndVerify(table, rows, cols, archiveTrx);
            childIds.set(table, rows.map((r) => r.id));
            batchMoved[table] = rows.length;
        }
        await copyAndVerify("orders", orders, orderCols, archiveTrx);
        batchMoved.orders = orders.length;

        for (const table of ORDER_CHILD_TABLES) {
            await deleteRowsByIds(table, childIds.get(table)!, hotTrx);
        }
        await deleteOrdersByIds(orderIds, cutoff, hotTrx);

        // Archive commits FIRST: a crash between the two commits leaves the
        // batch in both clusters (the next run converges via ON CONFLICT DO
        // NOTHING), never in neither.
        await archiveTrx.commit();
        await hotTrx.commit();

        recordBatch(stats, batchMoved);
        logger.info("archival.batch", {region, kind: "orders", ...batchMoved, ms: Date.now() - t0});
        return orders.length;
    } catch (err) {
        if (!archiveTrx.isCompleted()) await archiveTrx.rollback();
        if (!hotTrx.isCompleted()) await hotTrx.rollback();
        throw err;
    }
}

/** payment_webhook_events by received_at (no order_id to travel with). Returns rows moved. */
async function moveWebhookEventBatch(
    region: string,
    hot: Knex,
    archive: Knex,
    cutoff: Date,
    columns: Map<ArchivedTable, TableColumn[]>,
    stats: ArchivalRunStats,
): Promise<number> {
    const t0 = Date.now();
    const hotTrx = await hot.transaction();
    const archiveTrx = await archive.transaction();
    try {
        const cols = columns.get("payment_webhook_events")!;
        const rows = await lockWebhookEventsBefore(cols.map((c) => c.name), cutoff, env.archival.batchSize, hotTrx);
        if (rows.length === 0) {
            await archiveTrx.rollback();
            await hotTrx.rollback();
            return 0;
        }

        await copyAndVerify("payment_webhook_events", rows, cols, archiveTrx);
        await deleteRowsByIds("payment_webhook_events", rows.map((r) => r.id), hotTrx);

        await archiveTrx.commit();
        await hotTrx.commit();

        recordBatch(stats, {payment_webhook_events: rows.length});
        logger.info("archival.batch", {region, kind: "payment_webhook_events", payment_webhook_events: rows.length, ms: Date.now() - t0});
        return rows.length;
    } catch (err) {
        if (!archiveTrx.isCompleted()) await archiveTrx.rollback();
        if (!hotTrx.isCompleted()) await hotTrx.rollback();
        throw err;
    }
}

async function copyAndVerify(table: ArchivedTable, rows: ArchiveRow[], cols: TableColumn[], archiveTrx: Knex): Promise<void> {
    if (rows.length === 0) return;
    await insertRowsIgnoringConflicts(table, rows, cols, archiveTrx);
    const found = await countRowsByIds(table, rows.map((r) => r.id), archiveTrx);
    if (found !== rows.length) throw archiveCopyVerificationError(table, rows.length, found);
}

function recordBatch(stats: ArchivalRunStats, moved: Partial<Record<ArchivedTable, number>>): void {
    stats.batches += 1;
    for (const [table, n] of Object.entries(moved) as [ArchivedTable, number][]) {
        stats.moved[table] += n;
    }
}

/**
 * One nightly job per region (ARCHIVAL_CRON, UTC). Per-region jobs keep one
 * region's backlog from delaying another's.
 */
export function registerArchivalJobs(): void {
    for (const region of env.regions) {
        register({
            name: `archival:${region}`,
            cron: env.archival.cron,
            timezone: "UTC",
            handler: async () => {
                await archiveRegion(region);
            },
        });
    }
}
