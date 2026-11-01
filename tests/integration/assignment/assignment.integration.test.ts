import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import type {Socket} from "socket.io-client";
import {db} from "../../../src/lib/knex/knex";
import {redisClient} from "../../../src/lib/cache/init";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {AssignmentService} from "../../../src/app/assignment/service/assignment.service";
import {startTestServer} from "../../helpers/server";
import {insertOrder} from "../../helpers/factories";
import {ADMIN, AGENT, authCookie, OTHER_AGENT} from "../../helpers/auth";
import {connectAs, nextEvent, subscribe} from "../../helpers/ws";
import {TestServer} from "../../helpers/types";
import type {JWTPayload} from "../../../src/lib/auth/jwt";

const REGION = "eg";
// Branch sits at 30.05,31.24. ~150m and ~700m away; the far point is ~16km out of the 5km radius.
const NEAR = {lat: 30.051, lng: 31.241};
const A_BIT_FURTHER = {lat: 30.055, lng: 31.245};
const FAR = {lat: 30.2, lng: 31.24};

const offerKey = (publicId: string) => `offer:order:${publicId}`;
const claimKey = (publicId: string) => `claim:order:${publicId}`;
const attemptsKey = (publicId: string) => `assign:attempts:${publicId}`;

describe("delivery assignment (offer → accept / reject, admin override)", () => {
    let app: TestServer;
    let assignment: AssignmentService;
    const sockets: Socket[] = [];

    const goOnline = (user: JWTPayload, at: {lat: number; lng: number}) =>
        request(app.server).post("/api/agents/presence/online").set("X-Region", REGION).set("Cookie", authCookie(user)).send(at);

    const agentAction = (user: JWTPayload, publicId: string, action: "accept" | "reject") =>
        request(app.server)
            .post(`/api/agents/orders/${publicId}/${action}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(user))
            .set("Idempotency-Key", randomUUID());

    const listen = async (user: JWTPayload, channel: string) => {
        const socket = await connectAs(app.baseUrl, user);
        await subscribe(socket, channel);
        sockets.push(socket);
        return socket;
    };

    beforeAll(async () => {
        app = await startTestServer();
        assignment = container.resolve<AssignmentService>(TOKENS.AssignmentService);
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    afterEach(() => {
        sockets.splice(0).forEach((s) => s.disconnect());
    });

    describe("worker tick", () => {
        it("offers a ready order to nearby online agents, nearest first", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await goOnline(OTHER_AGENT, A_BIT_FURTHER);
            await goOnline(AGENT, NEAR);
            const agentSocket = await listen(AGENT, `agent:${AGENT.userId}`);
            const offered = nextEvent(agentSocket, "task.offered");

            // Act
            const result = await assignment.tickRegion(REGION);

            // Assert
            expect(result).toEqual({processed: 1, offered: 1, skipped: 0});
            expect(await redisClient.get(offerKey(order.public_id))).toBe("300,301");
            expect(await redisClient.get(attemptsKey(order.public_id))).toBe("1");
            await expect(offered).resolves.toMatchObject({
                orderId: order.public_id,
                branch: {id: 20, lat: 30.05, lng: 31.24, name: "Downtown", addressText: "1 Talaat Harb St, Cairo"},
                dropoff: {lat: 30.0444, lng: 31.2357},
                total: 18000,
                paymentMethod: "cod",
            });
        });

        it("skips agents that are busy, stale or out of range and counts the failed attempt", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await goOnline(AGENT, FAR);
            await goOnline(OTHER_AGENT, NEAR);
            await redisClient.sadd(`presence:busy:${REGION}`, String(OTHER_AGENT.userId));
            await redisClient.geoadd(`presence:geo:${REGION}`, NEAR.lng, NEAR.lat, "302"); // in geo set, presence TTL expired

            // Act
            const result = await assignment.tickRegion(REGION);

            // Assert
            expect(result).toEqual({processed: 1, offered: 0, skipped: 1});
            expect(await redisClient.exists(offerKey(order.public_id))).toBe(0);
            expect(await redisClient.get(attemptsKey(order.public_id))).toBe("1");
        });

        it("does not re-offer while the current offer is still live", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await goOnline(AGENT, NEAR);
            await redisClient.set(offerKey(order.public_id), "301", "EX", 30);

            // Act
            const result = await assignment.tickRegion(REGION);

            // Assert
            expect(result.skipped).toBe(1);
            expect(await redisClient.get(offerKey(order.public_id))).toBe("301");
        });

        it("gives up after the max attempts and alerts admins", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(attemptsKey(order.public_id), "3");
            const adminSocket = await listen(ADMIN, "admin:alerts");
            const alert = nextEvent(adminSocket, "assignment.exhausted");

            // Act
            const result = await assignment.tickRegion(REGION);

            // Assert
            expect(result.skipped).toBe(1);
            await expect(alert).resolves.toEqual({orderId: order.public_id, attempts: 3});
        });
    });

    describe("POST /api/agents/orders/:publicId/accept", () => {
        it("lets an offered agent claim the order and tells the other candidates", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(offerKey(order.public_id), "300,301", "EX", 30);
            const loserSocket = await listen(OTHER_AGENT, `agent:${OTHER_AGENT.userId}`);
            const cancelled = nextEvent(loserSocket, "offer.cancelled");

            // Act
            const res = await agentAction(AGENT, order.public_id, "accept");

            // Assert
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({orderId: order.public_id, status: "assigned", pickup: {branchId: 20, name: "Downtown"}});
            const row = await db(REGION)("orders").where({id: order.id}).first("status", "delivery_agent_id", "assigned_at");
            expect(row).toMatchObject({status: "assigned", delivery_agent_id: "300"});
            expect(row.assigned_at).toBeInstanceOf(Date);
            expect(await redisClient.sismember(`presence:busy:${REGION}`, "300")).toBe(1);
            expect(await redisClient.get(claimKey(order.public_id))).toBe("300");
            expect(await redisClient.exists(offerKey(order.public_id))).toBe(0);
            await expect(cancelled).resolves.toEqual({orderId: order.public_id, reason: "claimed_by_other"});
        });

        it("returns 409 to the agent who loses the claim race", async () => {
            // Arrange — AGENT's claim lock is already held
            const order = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(offerKey(order.public_id), "300,301", "EX", 30);
            await redisClient.set(claimKey(order.public_id), "300", "EX", 300);

            // Act
            const res = await agentAction(OTHER_AGENT, order.public_id, "accept");

            // Assert
            expect(res.status).toBe(409);
            expect(res.body).toEqual({error: "OrderAlreadyClaimed"});
        });

        it("refuses agents who were not offered the order, or whose offer expired", async () => {
            // Arrange
            const offered = await insertOrder(REGION, {status: "ready"});
            const expired = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(offerKey(offered.public_id), "301", "EX", 30);

            // Act
            const notCandidate = await agentAction(AGENT, offered.public_id, "accept");
            const noOffer = await agentAction(AGENT, expired.public_id, "accept");

            // Assert
            expect(notCandidate.status).toBe(403);
            expect(notCandidate.body).toEqual({error: "NotInCandidateList"});
            expect(noOffer.status).toBe(404);
            expect(noOffer.body).toEqual({error: "OfferNotFoundOrExpired"});
        });

        it("releases the claim lock when the order is no longer ready", async () => {
            // Arrange — the customer cancelled while the offer was out
            const order = await insertOrder(REGION, {status: "cancelled"});
            await redisClient.set(offerKey(order.public_id), "300", "EX", 30);

            // Act
            const res = await agentAction(AGENT, order.public_id, "accept");

            // Assert
            expect(res.status).toBe(409);
            expect(res.body).toEqual({error: "OrderNotInReadyState"});
            expect(await redisClient.exists(claimKey(order.public_id))).toBe(0);
        });
    });

    describe("POST /api/agents/orders/:publicId/reject", () => {
        it("drops the rejecting agent from the live offer", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(offerKey(order.public_id), "300,301", "EX", 30);

            // Act
            const res = await agentAction(AGENT, order.public_id, "reject");

            // Assert
            expect(res.status).toBe(200);
            expect(await redisClient.get(offerKey(order.public_id))).toBe("301");
            expect(await redisClient.ttl(offerKey(order.public_id))).toBeGreaterThan(0);
        });

        it("withdraws the offer when the last candidate rejects", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(offerKey(order.public_id), "301", "EX", 30);

            // Act
            const res = await agentAction(OTHER_AGENT, order.public_id, "reject");

            // Assert
            expect(res.status).toBe(200);
            expect(await redisClient.exists(offerKey(order.public_id))).toBe(0);
        });

        it("refuses rejections from non-candidates and for expired offers", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(offerKey(order.public_id), "301", "EX", 30);

            // Act
            const notCandidate = await agentAction(AGENT, order.public_id, "reject");
            await redisClient.del(offerKey(order.public_id));
            const expired = await agentAction(OTHER_AGENT, order.public_id, "reject");

            // Assert
            expect(notCandidate.status).toBe(403);
            expect(expired.status).toBe(404);
        });
    });

    describe("POST /api/admin/orders/:publicId/assign", () => {
        const adminAssign = (publicId: string, body: object) =>
            request(app.server)
                .post(`/api/admin/orders/${publicId}/assign`)
                .set("X-Region", REGION)
                .set("Cookie", authCookie(ADMIN))
                .set("Idempotency-Key", randomUUID())
                .send(body);

        it("force-assigns a ready order to the chosen agent", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});
            const agentSocket = await listen(AGENT, `agent:${AGENT.userId}`);
            const assigned = nextEvent(agentSocket, "task.assigned");

            // Act
            const res = await adminAssign(order.public_id, {agentId: AGENT.userId});

            // Assert
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({orderId: order.public_id, status: "assigned"});
            expect(await redisClient.sismember(`presence:busy:${REGION}`, "300")).toBe(1);
            await expect(assigned).resolves.toMatchObject({orderId: order.public_id});
        });

        it("validates the agent id and refuses orders that are not ready or already claimed", async () => {
            // Arrange
            const placed = await insertOrder(REGION, {status: "placed"});
            const claimed = await insertOrder(REGION, {status: "ready"});
            await redisClient.set(claimKey(claimed.public_id), "301");

            // Act
            const missingAgent = await adminAssign(placed.public_id, {});
            const notReady = await adminAssign(placed.public_id, {agentId: AGENT.userId});
            const alreadyClaimed = await adminAssign(claimed.public_id, {agentId: AGENT.userId});

            // Assert
            expect(missingAgent.status).toBe(400);
            expect(missingAgent.body).toEqual({error: "agentId is required"});
            expect(notReady.status).toBe(409);
            expect(notReady.body).toEqual({error: "OrderNotInReadyState"});
            expect(alreadyClaimed.status).toBe(409);
            expect(alreadyClaimed.body).toEqual({error: "OrderAlreadyClaimed"});
        });

        it("is not available to agents", async () => {
            // Arrange
            const order = await insertOrder(REGION, {status: "ready"});

            // Act
            const res = await request(app.server)
                .post(`/api/admin/orders/${order.public_id}/assign`)
                .set("X-Region", REGION)
                .set("Cookie", authCookie(AGENT))
                .set("Idempotency-Key", randomUUID())
                .send({agentId: AGENT.userId});

            // Assert
            expect(res.status).toBe(403);
            expect(res.body).toEqual({error: "Permission denied"});
        });
    });
});
