import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import type {Socket} from "socket.io-client";
import {db} from "../../../src/lib/knex/knex";
import {env} from "../../../src/lib/config/env";
import {redisClient} from "../../../src/lib/cache/init";
import {startTestServer} from "../../helpers/server";
import {authCookie, CUSTOMER, OTHER_CUSTOMER, RESTAURANT_OWNER} from "../../helpers/auth";
import {connectAs, nextEvent, subscribe} from "../../helpers/ws";
import {BRANCH_ID, branchFixture} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";
import type {JWTPayload} from "../../../src/lib/auth/jwt";

const REGION = "eg";

// 2 × Koshary (7500) + 1 × tea (1000) = 16000; + delivery 2000 + service 1000 = 19000
function orderBody(overrides: Record<string, unknown> = {}) {
    return {
        branchId: BRANCH_ID,
        customerAddressId: 30,
        paymentMethod: "cod",
        items: [{productId: 501, quantity: 2}, {productId: 502, quantity: 1}],
        ...overrides,
    };
}

describe("POST /api/orders", () => {
    let app: TestServer;
    let branchSocket: Socket | undefined;

    const placeOrder = (body: object, user: JWTPayload = CUSTOMER, idempotencyKey: string = randomUUID()) =>
        request(app.server)
            .post("/api/orders")
            .set("X-Region", REGION)
            .set("Cookie", authCookie(user))
            .set("Idempotency-Key", idempotencyKey)
            .send(body);

    const countOrders = async () => Number((await db(REGION)("orders").count<{count: string}[]>("* as count"))[0].count);

    beforeAll(async () => {
        app = await startTestServer();
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    afterEach(() => {
        branchSocket?.disconnect();
        branchSocket = undefined;
    });

    it("places a COD order: prices from core, reserves stock, writes the outbox and notifies the branch", async () => {
        // Arrange
        branchSocket = await connectAs(app.baseUrl, RESTAURANT_OWNER);
        await subscribe(branchSocket, `branch:${BRANCH_ID}`);
        const announced = nextEvent(branchSocket, "order.created");

        // Act
        const res = await placeOrder(orderBody());

        // Assert — response DTO
        expect(res.status).toBe(201);
        const order = res.body.data;
        expect(order).toMatchObject({
            status: "placed",
            paymentMethod: "cod",
            branch: {id: 20},
            restaurant: {id: 10},
            customerAddress: {lat: 30.0444, lng: 31.2357, addressText: "12, Tahrir St, Cairo, Egypt"},
            subtotal: 16000,
            deliveryFee: 2000,
            serviceFee: 1000,
            total: 19000,
            currency: "EGP",
            items: [
                {productId: 501, name: "Koshary (large)", imageUrl: null, quantity: 2, unitPrice: 7500, lineTotal: 15000},
                {productId: 502, name: "Mint tea", imageUrl: "https://cdn.test/tea.png", quantity: 1, unitPrice: 1000, lineTotal: 1000},
            ],
        });
        expect(order.payment).toBeUndefined();

        // Assert — persisted order, items and outbox event in one shard
        const row = await db(REGION)("orders").where({public_id: order.publicId}).first("status", "total", "restaurant_owner_id", "branch_lat");
        expect(row).toEqual({status: "placed", total: 19000, restaurant_owner_id: "100", branch_lat: "30.0500000"});
        const [{count: itemCount}] = await db(REGION)("order_items").count<{count: string}[]>("* as count");
        expect(Number(itemCount)).toBe(2);
        const outbox = await db(REGION)("events_outbox").select("event_type", "aggregate_id", "payload");
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({event_type: "order.placed", aggregate_id: order.publicId, payload: {total: 19000, status: "placed"}});

        // Assert — stock reserved in core, keyed by the order's public id
        const [reserve] = app.core.callsTo("POST", `/api/internal/branches/${BRANCH_ID}/reserve-stock`);
        expect(reserve.body).toEqual({items: [{productId: 501, quantity: 2}, {productId: 502, quantity: 1}]});
        expect(reserve.headers["idempotency-key"]).toBe(order.publicId);

        // Assert — branch dashboard got the new order live
        await expect(announced).resolves.toMatchObject({publicId: order.publicId, status: "placed", itemsCount: 2});
    });

    it("places an online order as pending_payment and returns the Kashier checkout session", async () => {
        // Arrange
        const body = orderBody({paymentMethod: "online"});

        // Act
        const res = await placeOrder(body);

        // Assert
        expect(res.status).toBe(201);
        const order = res.body.data;
        expect(order.status).toBe("pending_payment");
        expect(order.payment).toEqual({
            sessionId: "1",
            providerSessionId: "ks_session_1",
            redirectUrl: "https://checkout.kashier.test/ks_session_1",
            expiresAt: expect.stringMatching(/Z$/),
        });

        const [kashierCall] = app.kashier.callsTo("POST", "/v3/payment/sessions");
        expect(kashierCall.body).toMatchObject({
            merchantId: "MID-TEST",
            amount: "190.00",
            currency: "EGP",
            order: order.publicId,
            type: "one-time",
            serverWebhook: env.kashier.webhookUrl,
            customer: {reference: "1"},
        });
        expect(kashierCall.headers["api-key"]).toBe(env.kashier.apiKey);
        expect(kashierCall.headers.authorization).toBe(env.kashier.secretKey);

        const session = await db(REGION)("payment_sessions").first("status", "amount", "provider_session_id");
        expect(session).toEqual({status: "initialized", amount: 19000, provider_session_id: "ks_session_1"});
        // order.placed is only emitted once the payment webhook confirms the charge
        const [{count}] = await db(REGION)("events_outbox").count<{count: string}[]>("* as count");
        expect(Number(count)).toBe(0);
    });

    it("replays the stored response for a retried request with the same Idempotency-Key", async () => {
        // Arrange
        const key = randomUUID();
        const first = await placeOrder(orderBody(), CUSTOMER, key);

        // Act
        const replay = await placeOrder(orderBody(), CUSTOMER, key);

        // Assert
        expect(first.status).toBe(201);
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body);
        expect(await countOrders()).toBe(1);
        expect(app.core.callsTo("POST", "/api/internal/branches/20/reserve-stock")).toHaveLength(1);
    });

    it("rejects the order with 409 when core reports too little stock, without reserving anything", async () => {
        // Arrange
        app.core.products.get(BRANCH_ID)![0].stock = 1;

        // Act
        const res = await placeOrder(orderBody());

        // Assert
        expect(res.status).toBe(409);
        expect(res.body).toEqual({error: 'OutOfStock: [{"productId":501,"requested":2,"available":1}]'});
        expect(await countOrders()).toBe(0);
        expect(app.core.callsTo("POST", "/api/internal/branches/20/reserve-stock")).toHaveLength(0);
    });

    it("rejects the order when the branch is closed for orders", async () => {
        // Arrange
        app.core.branches.set(BRANCH_ID, branchFixture({acceptOrders: false}));

        // Act
        const res = await placeOrder(orderBody());

        // Assert
        expect(res.status).toBe(409);
        expect(res.body).toEqual({error: "BranchNotAcceptingOrders"});
        expect(await countOrders()).toBe(0);
    });

    it("rejects the order when core has deactivated the branch (reject-new-orders flag)", async () => {
        // Arrange — the flag core's branch.deactivated event leaves in Redis
        await redisClient.set(`branch:reject-new-orders:${BRANCH_ID}`, "1");

        // Act
        const res = await placeOrder(orderBody());

        // Assert
        expect(res.status).toBe(409);
        expect(res.body).toEqual({error: "BranchNotAcceptingOrders"});
    });

    it("forbids delivering to an address that belongs to another customer", async () => {
        // Arrange — address 30 belongs to CUSTOMER

        // Act
        const res = await placeOrder(orderBody(), OTHER_CUSTOMER);

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toEqual({error: "User not authorised"});
        expect(app.core.callsTo("POST", "/api/internal/branches/20/reserve-stock")).toHaveLength(0);
    });

    it("surfaces core's refusal to reserve stock and stores no order", async () => {
        // Arrange
        app.core.failNext("POST", `/api/internal/branches/${BRANCH_ID}/reserve-stock`, 409, 1, {error: "InsufficientStock"});

        // Act
        const res = await placeOrder(orderBody());

        // Assert
        expect(res.status).toBe(409);
        expect(res.body).toEqual({error: 'core-service 409: {"error":"InsufficientStock"}'});
        expect(await countOrders()).toBe(0);
    });

    it("voids the order and releases the stock when Kashier cannot open a session", async () => {
        // Arrange
        app.kashier.failNext("POST", "/v3/payment/sessions", 400, 1, {message: "invalid merchant"});

        // Act
        const res = await placeOrder(orderBody({paymentMethod: "online"}));

        // Assert
        expect(res.status).toBe(503);
        expect(res.body).toEqual({error: "Payment provider unavailable"});

        const row = await db(REGION)("orders").first("public_id", "status", "cancelled_at");
        expect(row.status).toBe("cancelled");
        expect(row.cancelled_at).toBeInstanceOf(Date);
        const [release] = app.core.callsTo("POST", `/api/internal/branches/${BRANCH_ID}/release-stock`);
        expect(release.headers["idempotency-key"]).toBe(row.public_id);
        expect(release.body).toEqual({items: [{productId: 501, quantity: 2}, {productId: 502, quantity: 1}]});
    });

    it("rejects an invalid body with 400 before calling core", async () => {
        // Arrange
        const body = orderBody({items: []});

        // Act
        const res = await placeOrder(body);

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toEqual({error: "items must contain at least 1 elements"});
        expect(app.core.calls).toHaveLength(0);
    });
});
