import "reflect-metadata";
import request from "supertest";
import {db} from "../../../src/lib/knex/knex";
import {env} from "../../../src/lib/config/env";
import {redisClient} from "../../../src/lib/cache/init";
import {messageBroker} from "../../../src/lib/messaging/init";
import {listJobs} from "../../../src/lib/jobs/job-registry";
import {registerAssignmentJobs} from "../../../src/app/assignment/jobs";
import {registerOutboxDrainJobs} from "../../../src/lib/events/jobs";
import {registerArchivalJobs} from "../../../src/lib/jobs/archival.worker";
import {insertOutboxEvent} from "../../../src/lib/events/outbox.repo";
import {startTestServer} from "../../helpers/server";
import {insertOrder} from "../../helpers/factories";
import {AmqpProbe} from "../../helpers/amqp";
import {AGENT, authCookie} from "../../helpers/auth";
import {TestServer} from "../../helpers/types";

const REGION = "eg";
const PROBE_QUEUE = "order-service.jobs.test-probe";

/** Runs a registered job's handler once, the way the scheduler would on a tick. */
async function runJob(name: string): Promise<void> {
    const job = listJobs().find((j) => j.name === name);
    if (!job) throw new Error(`job ${name} not registered`);
    await job.handler();
}

describe("worker job registrations", () => {
    let app: TestServer;
    let probe: AmqpProbe;

    beforeAll(async () => {
        app = await startTestServer();
        probe = await AmqpProbe.open();
        await probe.bindCatchAllQueue(env.outboundEvents.exchange, PROBE_QUEUE); // ensures the exchange exists
        registerAssignmentJobs();
        registerOutboxDrainJobs();
        registerArchivalJobs();
    });

    afterAll(async () => {
        // Always release the app (fixed stub ports) even if broker teardown fails.
        await messageBroker.close().catch(() => {});
        await probe?.close().catch(() => {});
        await app?.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("registers one assignment, outbox-drain and archival job per region", () => {
        // Arrange — registrations ran in beforeAll

        // Act
        const jobs = listJobs().map(({name, cron, timezone}) => ({name, cron, timezone}));

        // Assert
        expect(jobs).toEqual([
            {name: "assignment-tick:eg", cron: "*/10 * * * * *", timezone: undefined},
            {name: "outbox-drain:eg", cron: "*/2 * * * * *", timezone: undefined},
            {name: "archival:eg", cron: "0 3 * * *", timezone: "UTC"},
        ]);
    });

    it("assignment tick offers ready orders to online agents", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "ready"});
        await request(app.server)
            .post("/api/agents/presence/online")
            .set("X-Region", REGION)
            .set("Cookie", authCookie(AGENT))
            .send({lat: 30.051, lng: 31.241});

        // Act
        await runJob("assignment-tick:eg");

        // Assert
        expect(await redisClient.get(`offer:order:${order.public_id}`)).toBe(String(AGENT.userId));
    });

    it("outbox drain publishes the region's pending events", async () => {
        // Arrange
        await insertOutboxEvent(db(REGION), {aggregateType: "order", aggregateId: "abc", eventType: "order.placed", payload: {}});

        // Act
        await runJob("outbox-drain:eg");

        // Assert
        const row = await db(REGION)("events_outbox").first("dispatched_at");
        expect(row.dispatched_at).toBeInstanceOf(Date);
    });

    it("archival job archives the region", async () => {
        // Arrange
        const lastYear = new Date().getUTCFullYear() - 1;
        await insertOrder(REGION, {status: "cancelled", created_at: new Date(Date.UTC(lastYear, 1, 1))});

        // Act
        await runJob("archival:eg");

        // Assert
        expect(await db(REGION)("orders").count<{count: string}[]>("* as count")).toEqual([{count: "0"}]);
    });
});
