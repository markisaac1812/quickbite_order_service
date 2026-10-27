import {Knex} from "knex";
import {ArchivedTable, ArchiveRow, OrderChildTable, TableColumn} from "./job.types";

// Postgres caps bind parameters per statement at 65535; stay well under it.
const MAX_BIND_PARAMS = 60_000;

/**
 * Column list for a table, read from the catalog. The archival worker copies
 * rows verbatim, so deriving the list (instead of hard-coding it) means a
 * column added by a future migration is archived too rather than silently
 * dropped. Called once per table per run, not per batch.
 */
export async function listTableColumns(table: ArchivedTable, conn: Knex): Promise<TableColumn[]> {
    const rows = await conn("information_schema.columns")
        .select("column_name", "data_type")
        .whereRaw("table_schema = current_schema()")
        .where("table_name", table)
        .orderBy("ordinal_position", "asc");
    return rows.map((r: {column_name: string; data_type: string}) => ({
        name: r.column_name,
        isJson: r.data_type === "json" || r.data_type === "jsonb",
    }));
}

/**
 * Locks and returns the next batch of terminal orders created before `cutoff`.
 * No index needed: `orders` is RANGE-partitioned on created_at, so the
 * predicate prunes the scan to prior-year partitions (+ default), where nearly
 * every row qualifies and LIMIT stops the scan early.
 */
export async function lockArchivableOrders(
    columns: string[],
    cutoff: Date,
    statuses: readonly string[],
    limit: number,
    conn: Knex,
): Promise<ArchiveRow[]> {
    return conn("orders")
        .select(columns)
        .where("created_at", "<", cutoff)
        .whereIn("status", statuses as string[])
        .limit(limit)
        .forUpdate();
}

/**
 * All child rows for a batch of orders. Backed by each table's order_id index
 * (idx_order_items_order_id, idx_transactions_order_id,
 * idx_payment_sessions_order_id, uq_agent_earnings_order_id).
 */
export async function selectRowsByOrderIds(
    table: OrderChildTable,
    columns: string[],
    orderIds: unknown[],
    conn: Knex,
): Promise<ArchiveRow[]> {
    if (orderIds.length === 0) return [];
    return conn(table).select(columns).whereIn("order_id", orderIds as string[]);
}

/** Backed by idx_payment_webhook_events_received_at. */
export async function lockWebhookEventsBefore(
    columns: string[],
    cutoff: Date,
    limit: number,
    conn: Knex,
): Promise<ArchiveRow[]> {
    return conn("payment_webhook_events")
        .select(columns)
        .where("received_at", "<", cutoff)
        .orderBy("received_at", "asc")
        .limit(limit)
        .forUpdate();
}

/**
 * INSERT … ON CONFLICT DO NOTHING, chunked under the bind-parameter cap.
 * Conflicts are expected after a crash between the archive and hot commits:
 * the rows already exist on archive, so the re-run skips them.
 */
export async function insertRowsIgnoringConflicts(
    table: ArchivedTable,
    rows: ArchiveRow[],
    columns: TableColumn[],
    conn: Knex,
): Promise<void> {
    if (rows.length === 0) return;
    const jsonColumns = columns.filter((c) => c.isJson).map((c) => c.name);
    const prepared = jsonColumns.length === 0 ? rows : rows.map((row) => {
        const copy = {...row};
        for (const col of jsonColumns) {
            if (copy[col] !== null && copy[col] !== undefined) copy[col] = JSON.stringify(copy[col]);
        }
        return copy;
    });

    const chunkSize = Math.max(1, Math.floor(MAX_BIND_PARAMS / columns.length));
    for (let i = 0; i < prepared.length; i += chunkSize) {
        await conn(table).insert(prepared.slice(i, i + chunkSize)).onConflict().ignore();
    }
}

/** PK lookup — used to verify a copy landed before deleting the source. */
export async function countRowsByIds(table: ArchivedTable, ids: unknown[], conn: Knex): Promise<number> {
    if (ids.length === 0) return 0;
    const [row] = await conn(table).count<{count: string}[]>("id as count").whereIn("id", ids as string[]);
    return Number(row.count);
}

/** PK delete for the non-partitioned tables. */
export async function deleteRowsByIds(table: Exclude<ArchivedTable, "orders">, ids: unknown[], conn: Knex): Promise<void> {
    if (ids.length === 0) return;
    await conn(table).whereIn("id", ids as string[]).del();
}

/** created_at predicate prunes the delete to prior-year partitions. */
export async function deleteOrdersByIds(ids: unknown[], cutoff: Date, conn: Knex): Promise<void> {
    if (ids.length === 0) return;
    await conn("orders").whereIn("id", ids as string[]).where("created_at", "<", cutoff).del();
}
