/**
 * A scheduled background job. Anything added to the registry runs in the
 * worker process at the given cron cadence.
 *
 * The handler receives nothing — if it needs context (region, batch size, etc.)
 * it pulls from env or DI itself.
 */
export interface ScheduledJob {
    /** Stable id used in logs and metrics. e.g. `assignment-tick:eg`. */
    name: string;

    /**
     * Standard 5- or 6-field cron expression (node-cron syntax).
     *   "*\/10 * * * * *" — every 10 seconds (6-field form)
     *   "0 3 * * *"       — daily at 03:00 (5-field form)
     */
    cron: string;

    /** Optional timezone (IANA, e.g. "Africa/Cairo"). Defaults to UTC. */
    timezone?: string;

    /** The work. May be sync or async; throws are caught + logged by the scheduler. */
    handler: () => Promise<void> | void;
}

// ── Archival worker ─────────────────────────────────────────────────────

/** Tables the archival worker moves hot → archive. */
export type ArchivedTable =
    | "orders"
    | "order_items"
    | "transactions"
    | "payment_sessions"
    | "agent_earnings"
    | "payment_webhook_events";

/** Child tables keyed by `order_id` that travel with their order. */
export type OrderChildTable = Exclude<ArchivedTable, "orders" | "payment_webhook_events">;

/** A raw row copied verbatim between clusters (snake_case columns). */
export type ArchiveRow = Record<string, unknown>;

/** Column metadata read from information_schema. */
export interface TableColumn {
    name: string;
    /** json/jsonb columns are re-serialized on insert (pg returns them parsed). */
    isJson: boolean;
}

export interface ArchivalRunStats {
    region: string;
    batches: number;
    moved: Record<ArchivedTable, number>;
    total: number;
    /** true when ARCHIVAL_MAX_RUNTIME_MIN elapsed before the backlog was drained. */
    stoppedEarly: boolean;
    /** set when another process holds `archival:<region>:lock`. */
    skipped?: "lock-held";
    ms: number;
}
