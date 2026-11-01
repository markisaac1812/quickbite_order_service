import "reflect-metadata";
import request from "supertest";
import {db} from "../../../src/lib/knex/knex";
import {redisClient} from "../../../src/lib/cache/init";
import {startTestServer} from "../../helpers/server";
import {insertOrder} from "../../helpers/factories";
import {AGENT, authCookie, CUSTOMER} from "../../helpers/auth";
import {TestServer} from "../../helpers/types";
import type {JWTPayload} from "../../../src/lib/auth/jwt";

const REGION = "eg";
const META_KEY = `presence:meta:${REGION}:${AGENT.userId}`;
const GEO_KEY = `presence:geo:${REGION}`;
const BUSY_KEY = `presence:busy:${REGION}`;

describe("agent presence (/api/agents/presence/*)", () => {
    let app: TestServer;

    const post = (path: string, user: JWTPayload, body: object = {}) =>
        request(app.server).post(`/api/agents/presence/${path}`).set("X-Region", REGION).set("Cookie", authCookie(user)).send(body);

    beforeAll(async () => {
        app = await startTestServer();
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("marks the agent online with a TTL'd location and adds them to the region's geo set", async () => {
        // Arrange
        const location = {lat: 30.051, lng: 31.241};

        // Act
        const res = await post("online", AGENT, location);

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ok: true});
        const meta = await redisClient.hgetall(META_KEY);
        expect(meta).toMatchObject({lat: "30.051", lng: "31.241"});
        expect(Number(meta.lastSeenAt)).toBeGreaterThan(0);
        const ttl = await redisClient.ttl(META_KEY);
        expect(ttl).toBeGreaterThan(290);
        expect(ttl).toBeLessThanOrEqual(300);
        const [[lng, lat]] = (await redisClient.geopos(GEO_KEY, String(AGENT.userId))) as [string, string][];
        expect(Number(lat)).toBeCloseTo(30.051, 4);
        expect(Number(lng)).toBeCloseTo(31.241, 4);
    });

    it("moves the agent on ping", async () => {
        // Arrange
        await post("online", AGENT, {lat: 30.051, lng: 31.241});

        // Act
        const res = await post("ping", AGENT, {lat: 30.06, lng: 31.25});

        // Assert
        expect(res.status).toBe(200);
        expect(await redisClient.hget(META_KEY, "lat")).toBe("30.06");
    });

    it("going offline hands an assigned (not yet picked) order back to the pool", async () => {
        // Arrange
        await post("online", AGENT, {lat: 30.051, lng: 31.241});
        await redisClient.sadd(BUSY_KEY, String(AGENT.userId));
        const order = await insertOrder(REGION, {status: "assigned", delivery_agent_id: AGENT.userId, assigned_at: new Date()});

        // Act
        const res = await post("offline", AGENT);

        // Assert
        expect(res.status).toBe(200);
        const row = await db(REGION)("orders").where({id: order.id}).first("status", "delivery_agent_id", "assigned_at");
        expect(row).toEqual({status: "ready", delivery_agent_id: null, assigned_at: null});
        expect(await redisClient.exists(META_KEY)).toBe(0);
        expect(await redisClient.geopos(GEO_KEY, String(AGENT.userId))).toEqual([null]);
        expect(await redisClient.sismember(BUSY_KEY, String(AGENT.userId))).toBe(0);
    });

    it("refuses to go offline while carrying a picked order", async () => {
        // Arrange
        await post("online", AGENT, {lat: 30.051, lng: 31.241});
        await insertOrder(REGION, {status: "picked", delivery_agent_id: AGENT.userId});

        // Act
        const res = await post("offline", AGENT);

        // Assert
        expect(res.status).toBe(409);
        expect(res.body).toEqual({error: "OfflineWhilePickedForbidden"});
        expect(await redisClient.exists(META_KEY)).toBe(1);
    });

    it("is reserved for delivery agents and validates coordinates", async () => {
        // Arrange
        const location = {lat: 30.051, lng: 31.241};

        // Act
        const asCustomer = await post("online", CUSTOMER, location);
        const badLocation = await post("online", AGENT, {lat: 123, lng: 31.241});

        // Assert
        expect(asCustomer.status).toBe(403);
        expect(asCustomer.body).toEqual({error: "Agent role required"});
        expect(badLocation.status).toBe(400);
        expect(badLocation.body).toEqual({error: "lat must be a latitude string or number"});
    });
});
