import type {Knex} from "knex";

/**
 * payment_webhook_events has no order_id, so the archival worker can't move it
 * alongside its order — it scans by received_at instead. Without this index
 * that scan is a full table seq scan every night.
 */
export async function up(knex: Knex): Promise<void> {
    // supports archival worker batch scan: received_at < start of current year
    await knex.raw(`CREATE INDEX idx_payment_webhook_events_received_at ON payment_webhook_events (received_at)`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS idx_payment_webhook_events_received_at`);
}
