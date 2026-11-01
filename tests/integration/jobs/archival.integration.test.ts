import "reflect-metadata";
import {db, dbArchive} from "../../../src/lib/knex/knex";
import {redisClient} from "../../../src/lib/cache/init";
import {archiveRegion} from "../../../src/lib/jobs/archival.worker";
import {startTestServer} from "../../helpers/server";
import {
    insertAgentEarning,
    insertOrder,
    insertOrderItem,
    insertPaymentSession,
    insertTransaction,
    insertWebhookEvent,
} from "../../helpers/factories";
import {AGENT} from "../../helpers/auth";
import {TestServer} from "../../helpers/types";

const REGION = "eg";
const LAST_YEAR = new Date().getUTCFullYear() - 1;
const lastYear = (month: number, day: number) => new Date(Date.UTC(LAST_YEAR, month, day, 12));

/** A delivered prior-year order with every child table populated. */
async function seedArchivableOrder() {
    const order = await insertOrder(REGION, {status: "delivered", delivery_agent_id: AGENT.userId, created_at: lastYear(5, 1)});
    await insertOrderItem(REGION, order.id);
    await insertTransaction(REGION, {order_id: order.id});
    await insertPaymentSession(REGION, order.id, {provider_session_id: "ks_archived", status: "captured"});
    await insertAgentEarning(REGION, {agent_id: AGENT.userId, order_id: order.id});
    return order;
}

const count = async (conn: ReturnType<typeof db>, table: string) =>
    Number((await conn(table).count<{count: string}[]>("* as count"))[0].count);

describe("cold archival worker (hot → archive cluster)", () => {
    let app: TestServer;

    beforeAll(async () => {
        app = await startTestServer();
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("moves terminal prior-year orders with all their children, plus prior-year webhook events", async () => {
        // Arrange
        const archivable = await seedArchivableOrder();
        const inFlight = await insertOrder(REGION, {status: "ready", created_at: lastYear(5, 2)});
        const currentYear = await insertOrder(REGION, {status: "delivered"});
        await insertWebhookEvent(REGION, {provider_event_id: "TX-OLD", received_at: lastYear(5, 1)});
        await insertWebhookEvent(REGION, {provider_event_id: "TX-NEW"});

        // Act
        const stats = await archiveRegion(REGION);

        // Assert — run stats
        expect(stats).toMatchObject({
            region: REGION,
            batches: 2,
            moved: {orders: 1, order_items: 1, transactions: 1, payment_sessions: 1, agent_earnings: 1, payment_webhook_events: 1},
            total: 6,
            stoppedEarly: false,
        });

        // Assert — hot keeps in-flight + current-year rows only
        const hot = db(REGION);
        expect((await hot("orders").pluck("public_id")).sort()).toEqual([inFlight.public_id, currentYear.public_id].sort());
        for (const table of ["order_items", "transactions", "payment_sessions", "agent_earnings"]) {
            expect(await count(hot, table)).toBe(0);
        }
        expect(await hot("payment_webhook_events").pluck("provider_event_id")).toEqual(["TX-NEW"]);

        // Assert — archive has the order verbatim, JSON columns intact
        const archive = dbArchive(REGION);
        const archivedOrder = await archive("orders").first("id", "public_id", "status");
        expect(archivedOrder).toEqual({id: String(archivable.id), public_id: archivable.public_id, status: "delivered"});
        expect((await archive("payment_sessions").first("raw_init_payload")).raw_init_payload).toEqual({_id: "ks_archived"});
        expect(await archive("payment_webhook_events").pluck("provider_event_id")).toEqual(["TX-OLD"]);

        // Assert — the run released its lock
        expect(await redisClient.exists(`archival:${REGION}:lock`)).toBe(0);
    });

    it("skips the run while another process holds the region lock", async () => {
        // Arrange
        await seedArchivableOrder();
        await redisClient.set(`archival:${REGION}:lock`, "other-process");

        // Act
        const stats = await archiveRegion(REGION);

        // Assert
        expect(stats).toMatchObject({skipped: "lock-held", total: 0});
        expect(await count(db(REGION), "orders")).toBe(1);
    });

    it("converges after a crash that left a batch on both clusters", async () => {
        // Arrange — archive committed, hot did not: the order already exists on archive
        const order = await seedArchivableOrder();
        await insertOrder(REGION, {id: order.id, public_id: order.public_id, status: "delivered", created_at: order.created_at}, "archive");

        // Act
        const stats = await archiveRegion(REGION);

        // Assert
        expect(stats.moved.orders).toBe(1);
        expect(await count(db(REGION), "orders")).toBe(0);
        expect(await count(dbArchive(REGION), "orders")).toBe(1);
    });

    it("aborts before moving anything when the archive schema is behind the hot schema", async () => {
        // Arrange — a column that exists on hot but was never migrated on archive
        await seedArchivableOrder();
        await db(REGION).raw("ALTER TABLE agent_earnings ADD COLUMN archival_probe INT");

        try {
            // Act
            const act = archiveRegion(REGION);

            // Assert
            await expect(act).rejects.toMatchObject({
                statusCode: 500,
                message: "ArchiveSchemaMismatch: agent_earnings is missing [archival_probe] on the archive cluster — run migrations with CLUSTER=archive",
            });
            expect(await count(db(REGION), "orders")).toBe(1);
            expect(await redisClient.exists(`archival:${REGION}:lock`)).toBe(0);
        } finally {
            await db(REGION).raw("ALTER TABLE agent_earnings DROP COLUMN archival_probe");
        }
    });
});
