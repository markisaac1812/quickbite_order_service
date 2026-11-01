import "reflect-metadata";
import {randomUUID} from "crypto";
import {db} from "../../../src/lib/knex/knex";
import {env} from "../../../src/lib/config/env";
import {messageBroker} from "../../../src/lib/messaging/init";
import {drainOutboxForRegion} from "../../../src/lib/events/outbox-drain";
import {insertOutboxEvents} from "../../../src/lib/events/outbox.repo";
import {startTestServer} from "../../helpers/server";
import {AmqpProbe} from "../../helpers/amqp";
import {waitFor} from "../../helpers/wait";
import {TestServer} from "../../helpers/types";

const REGION = "eg";
const PROBE_QUEUE = "order-service.outbox-drain.test-probe";

describe("outbox drain → order.events (real RabbitMQ)", () => {
    let app: TestServer;
    let probe: AmqpProbe;

    beforeAll(async () => {
        app = await startTestServer();
        probe = await AmqpProbe.open();
        await probe.bindCatchAllQueue(env.outboundEvents.exchange, PROBE_QUEUE);
    });

    afterAll(async () => {
        // Always release the app (fixed stub ports) even if broker teardown fails.
        await messageBroker.close().catch(() => {});
        await probe?.close().catch(() => {});
        await app?.stop();
    });

    beforeEach(async () => {
        await app.reset();
        await probe.purge(PROBE_QUEUE);
    });

    it("publishes pending events with their envelope and marks them dispatched", async () => {
        // Arrange
        const orderId = randomUUID();
        await insertOutboxEvents(db(REGION), [
            {aggregateType: "order", aggregateId: orderId, eventType: "order.placed", payload: {orderId, total: 18000}},
            {aggregateType: "order", aggregateId: orderId, eventType: "order.accepted", payload: {orderId, status: "accepted"}},
        ]);

        // Act
        await drainOutboxForRegion(REGION);

        // Assert — rows dispatched
        const rows = await db(REGION)("events_outbox").orderBy("id").select("event_id", "dispatched_at", "attempts");
        expect(rows.every((r) => r.dispatched_at instanceof Date && r.attempts === 0)).toBe(true);

        // Assert — both events reached the exchange, routed by event type
        await waitFor(async () => (await probe.messageCount(PROBE_QUEUE)) === 2);
        const first = await probe.pop(PROBE_QUEUE);
        expect(first).toEqual({
            routingKey: "order.placed",
            body: {
                eventId: rows[0].event_id,
                eventType: "order.placed",
                occurredAt: expect.stringMatching(/Z$/),
                aggregateType: "order",
                aggregateId: orderId,
                region: REGION,
                payload: {orderId, total: 18000},
            },
        });
        expect((await probe.pop(PROBE_QUEUE))?.routingKey).toBe("order.accepted");
    });

    it("leaves already-dispatched events alone and is a no-op on an empty outbox", async () => {
        // Arrange
        await insertOutboxEvents(db(REGION), [{aggregateType: "order", aggregateId: "x", eventType: "order.placed", payload: {}}]);
        await db(REGION)("events_outbox").update({dispatched_at: new Date()});

        // Act
        await drainOutboxForRegion(REGION);
        await db(REGION)("events_outbox").del();
        await drainOutboxForRegion(REGION);

        // Assert
        expect(await probe.messageCount(PROBE_QUEUE)).toBe(0);
    });

    it("does nothing for an empty bulk insert", async () => {
        // Arrange
        const none: never[] = [];

        // Act
        await insertOutboxEvents(db(REGION), none);

        // Assert
        expect(await db(REGION)("events_outbox").count<{count: string}[]>("* as count")).toEqual([{count: "0"}]);
    });
});
