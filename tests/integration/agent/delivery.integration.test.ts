import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import {db} from "../../../src/lib/knex/knex";
import {redisClient} from "../../../src/lib/cache/init";
import {startTestServer} from "../../helpers/server";
import {insertAgentEarning, insertOrder} from "../../helpers/factories";
import {AGENT, authCookie, OTHER_AGENT} from "../../helpers/auth";
import {BRANCH_ID} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";
import type {JWTPayload} from "../../../src/lib/auth/jwt";

const REGION = "eg";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("agent deliveries (/api/agents/orders/:id/status, /tasks, /earnings)", () => {
    let app: TestServer;

    const transition = (user: JWTPayload, publicId: string, status: string) =>
        request(app.server)
            .patch(`/api/agents/orders/${publicId}/status`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(user))
            .set("Idempotency-Key", randomUUID())
            .send({status});

    const get = (path: string, user: JWTPayload = AGENT) =>
        request(app.server).get(path).set("X-Region", REGION).set("Cookie", authCookie(user));

    beforeAll(async () => {
        app = await startTestServer();
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("marks an assigned order picked", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "assigned", delivery_agent_id: AGENT.userId, assigned_at: minutesAgo(5)});

        // Act
        const res = await transition(AGENT, order.public_id, "picked");

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({orderId: order.public_id, status: "picked", pickup: {name: "Downtown"}});
        expect(res.body.data.pickedAt).toMatch(/Z$/);
        const row = await db(REGION)("orders").where({id: order.id}).first("status", "picked_at");
        expect(row.status).toBe("picked");
        expect(row.picked_at).toBeInstanceOf(Date);
    });

    it("settles a delivered COD order in one transaction: ledger, balance, earning, outbox", async () => {
        // Arrange — subtotal 15000, delivery 2000, service 1000, total 18000; branch commission 10%
        const order = await insertOrder(REGION, {status: "picked", delivery_agent_id: AGENT.userId, picked_at: minutesAgo(10)});
        await redisClient.sadd(`presence:busy:${REGION}`, String(AGENT.userId));
        await redisClient.set(`claim:order:${order.public_id}`, String(AGENT.userId));

        // Act
        const res = await transition(AGENT, order.public_id, "delivered");

        // Assert — response
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({orderId: order.public_id, status: "delivered"});

        // Assert — order row
        const conn = db(REGION);
        const row = await conn("orders").where({id: order.id}).first("status", "commission", "delivered_at");
        expect(row).toMatchObject({status: "delivered", commission: 1500});
        expect(row.delivered_at).toBeInstanceOf(Date);

        // Assert — ledger
        const ledger = await conn("transactions").orderBy("id").select("transaction_type", "method", "amount", "src_acc_id", "dst_acc_id", "idempotency_key");
        expect(ledger).toEqual([
            {transaction_type: "cod_collection", method: "cod", amount: 18000, src_acc_id: "1", dst_acc_id: "100", idempotency_key: `cod-collect:${order.public_id}`},
            {transaction_type: "commission", method: "system", amount: 1500, src_acc_id: "100", dst_acc_id: null, idempotency_key: `commission:${order.public_id}`},
            {transaction_type: "adjustment", method: "system", amount: 1000, src_acc_id: "100", dst_acc_id: null, idempotency_key: `service-fee:${order.public_id}`},
            {transaction_type: "adjustment", method: "system", amount: 2000, src_acc_id: "100", dst_acc_id: null, idempotency_key: `delivery-fee:${order.public_id}`},
        ]);

        // Assert — restaurant gets subtotal minus commission; agent gets 80% of the delivery fee
        expect(await conn("restaurant_balances").select("restaurant_id", "currency", "balance")).toEqual([{restaurant_id: "10", currency: "EGP", balance: 13500}]);
        expect(await conn("agent_earnings").select("agent_id", "amount")).toEqual([{agent_id: "300", amount: 1600}]);

        const outbox = await conn("events_outbox").select("event_type", "payload");
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({event_type: "order.delivered", payload: {commission: 1500, deliveryAgentId: 300}});

        // Assert — agent freed, claim lock dropped
        expect(await redisClient.sismember(`presence:busy:${REGION}`, "300")).toBe(0);
        expect(await redisClient.exists(`claim:order:${order.public_id}`)).toBe(0);
    });

    it("settles an online order with zero commission when core is unreachable", async () => {
        // Arrange — online: no cod_collection row; core fails all 3 retries for the branch
        const order = await insertOrder(REGION, {status: "picked", payment_method: "online", delivery_agent_id: AGENT.userId});
        app.core.failNext("GET", `/api/internal/branches/${BRANCH_ID}`, 503, 3);

        // Act
        const res = await transition(AGENT, order.public_id, "delivered");

        // Assert
        expect(res.status).toBe(200);
        const conn = db(REGION);
        expect((await conn("orders").where({id: order.id}).first("commission")).commission).toBe(0);
        expect(await conn("transactions").orderBy("id").pluck("idempotency_key")).toEqual([
            `service-fee:${order.public_id}`,
            `delivery-fee:${order.public_id}`,
        ]);
        expect((await conn("restaurant_balances").first("balance")).balance).toBe(15000);
    });

    it("refuses deliveries by an agent who does not hold the order, or out of order", async () => {
        // Arrange
        const picked = await insertOrder(REGION, {status: "picked", delivery_agent_id: AGENT.userId});
        const assigned = await insertOrder(REGION, {status: "assigned", delivery_agent_id: AGENT.userId});

        // Act
        const notMine = await transition(OTHER_AGENT, picked.public_id, "delivered");
        const notPickedYet = await transition(AGENT, assigned.public_id, "delivered");
        const notMineToPick = await transition(OTHER_AGENT, assigned.public_id, "picked");

        // Assert
        expect(notMine.status).toBe(403);
        expect(notMine.body).toEqual({error: "NotYourTask"});
        expect(notPickedYet.status).toBe(409);
        expect(notPickedYet.body).toEqual({error: "InvalidStatusTransition: assigned -> delivered"});
        expect(notMineToPick.status).toBe(403);
    });

    it("only accepts picked or delivered as targets and 404s unknown orders", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "assigned", delivery_agent_id: AGENT.userId});

        // Act
        const badTarget = await transition(AGENT, order.public_id, "cancelled");
        const unknown = await transition(AGENT, randomUUID(), "picked");

        // Assert
        expect(badTarget.status).toBe(400);
        expect(badTarget.body).toEqual({error: "status must be 'picked' or 'delivered'"});
        expect(unknown.status).toBe(404);
    });

    it("lists the agent's open tasks, enriched with branch details in one core call", async () => {
        // Arrange
        const assigned = await insertOrder(REGION, {status: "assigned", delivery_agent_id: AGENT.userId, assigned_at: minutesAgo(2)});
        const picked = await insertOrder(REGION, {status: "picked", delivery_agent_id: AGENT.userId, assigned_at: minutesAgo(1)});
        await insertOrder(REGION, {status: "delivered", delivery_agent_id: AGENT.userId, assigned_at: minutesAgo(30)});
        await insertOrder(REGION, {status: "assigned", delivery_agent_id: OTHER_AGENT.userId, assigned_at: minutesAgo(1)});

        // Act
        const res = await get("/api/agents/tasks");

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data.map((t: {orderId: string}) => t.orderId)).toEqual([picked.public_id, assigned.public_id]);
        expect(res.body.data[0].pickup).toEqual({branchId: 20, lat: 30.05, lng: 31.24, name: "Downtown", addressText: "1 Talaat Harb St, Cairo"});
        expect(app.core.callsTo("GET", "/api/internal/branches?ids=")).toHaveLength(1);
    });

    it("filters tasks by status and serves cached branches without calling core", async () => {
        // Arrange
        const delivered = await insertOrder(REGION, {status: "delivered", delivery_agent_id: AGENT.userId, assigned_at: minutesAgo(30)});
        await insertOrder(REGION, {status: "assigned", delivery_agent_id: AGENT.userId, assigned_at: minutesAgo(1)});
        await get("/api/agents/tasks"); // primes core:branch:20 in Redis
        const coreCallsBefore = app.core.calls.length;

        // Act
        const res = await get("/api/agents/tasks?status=delivered");

        // Assert
        expect(res.body.data.map((t: {orderId: string}) => t.orderId)).toEqual([delivered.public_id]);
        expect(app.core.calls.length).toBe(coreCallsBefore);
    });

    it("sums the agent's earnings for a date range", async () => {
        // Arrange
        await insertAgentEarning(REGION, {agent_id: AGENT.userId, order_id: 1, amount: 1600, earned_at: new Date("2026-05-03T10:00:00.000Z")});
        await insertAgentEarning(REGION, {agent_id: AGENT.userId, order_id: 2, amount: 1200, earned_at: new Date("2026-05-20T10:00:00.000Z")});
        await insertAgentEarning(REGION, {agent_id: AGENT.userId, order_id: 3, amount: 999, earned_at: new Date("2026-04-30T10:00:00.000Z")});
        await insertAgentEarning(REGION, {agent_id: OTHER_AGENT.userId, order_id: 4, amount: 5000, earned_at: new Date("2026-05-10T10:00:00.000Z")});

        // Act
        const res = await get("/api/agents/earnings?from=2026-05-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z");

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data.range).toEqual({from: "2026-05-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z"});
        expect(res.body.data.totals).toEqual({count: 2, sum: 2800, currency: "EGP"});
        expect(res.body.data.items.map((i: {amount: number}) => i.amount)).toEqual([1200, 1600]);
    });

    it("defaults earnings to the current month", async () => {
        // Arrange
        await insertAgentEarning(REGION, {agent_id: AGENT.userId, order_id: 1, amount: 1600});

        // Act
        const res = await get("/api/agents/earnings");

        // Assert
        expect(res.body.data.totals).toEqual({count: 1, sum: 1600, currency: "EGP"});
        expect(new Date(res.body.data.range.from).getUTCDate()).toBe(1);
    });
});
