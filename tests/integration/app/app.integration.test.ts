import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import {startTestServer} from "../../helpers/server";
import {authCookie, CUSTOMER} from "../../helpers/auth";
import {BRANCH_ID, branchFixture} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// One app per file: stop() closes the shared Redis client.
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

describe("app wiring", () => {
    it("reports every hot and archive shard healthy on /api/health", async () => {
        // Arrange — globalSetup created and migrated both test clusters

        // Act
        const res = await request(app.server).get("/api/health");

        // Assert
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            shards: [
                {region: "eg", cluster: "hot", ok: true},
                {region: "eg", cluster: "archive", ok: true},
            ],
        });
    });

    it("echoes the caller's correlation id, or mints one", async () => {
        // Arrange
        const incoming = "trace-abc-123";

        // Act
        const echoed = await request(app.server).get("/api/health").set("X-CorrelationId", incoming);
        const minted = await request(app.server).get("/api/health");

        // Assert
        expect(echoed.headers["x-correlationid"]).toBe(incoming);
        expect(minted.headers["x-correlationid"]).toMatch(UUID_V4);
    });
});

describe("error handling", () => {
    it("answers malformed JSON with 400 instead of a server error", async () => {
        // Arrange — truncated JSON
        const body = '{"branchId": 20,';

        // Act
        const res = await request(app.server).post("/api/orders").set("Content-Type", "application/json").send(body);

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toEqual({error: "Malformed JSON body"});
    });

    it("keeps the body parser's 413 for an oversized payload", async () => {
        // Arrange — express.json() caps bodies at 100kb
        const body = JSON.stringify({pad: "x".repeat(200_000)});

        // Act
        const res = await request(app.server).post("/api/orders").set("Content-Type", "application/json").send(body);

        // Assert
        expect(res.status).toBe(413);
        expect(res.body).toEqual({error: "request entity too large"});
    });

    it("hides the details of unexpected failures behind a generic 500", async () => {
        // Arrange — core reports a branch in a region this deployment has no shard for
        app.core.branches.set(BRANCH_ID, branchFixture({region: "SA"}));

        // Act
        const res = await request(app.server)
            .post("/api/orders")
            .set("X-Region", "eg")
            .set("Cookie", authCookie(CUSTOMER))
            .set("Idempotency-Key", randomUUID())
            .send({branchId: BRANCH_ID, customerAddressId: 30, paymentMethod: "cod", items: [{productId: 501, quantity: 1}]});

        // Assert
        expect(res.status).toBe(500);
        expect(res.body).toEqual({error: "Something went wrong"});
    });
});
