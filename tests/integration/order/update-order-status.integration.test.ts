import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import type {Socket} from "socket.io-client";
import {db} from "../../../src/lib/knex/knex";
import {startTestServer} from "../../helpers/server";
import {insertOrder, insertOrderItem} from "../../helpers/factories";
import {ADMIN, authCookie, CUSTOMER, OTHER_RESTAURANT_OWNER, RESTAURANT_OWNER} from "../../helpers/auth";
import {connectAs, nextEvent, subscribe} from "../../helpers/ws";
import {BRANCH_ID, RESTAURANT_ID} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";
import type {JWTPayload} from "../../../src/lib/auth/jwt";

const REGION = "eg";
const restaurantUrl = (publicId: string) => `/api/restaurants/${RESTAURANT_ID}/branches/${BRANCH_ID}/orders/${publicId}/status`;

describe("PATCH order status (restaurant, customer and admin routes)", () => {
    let app: TestServer;
    let customerSocket: Socket | undefined;

    const patchStatus = (url: string, user: JWTPayload, body: object) =>
        request(app.server)
            .patch(url)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(user))
            .set("Idempotency-Key", randomUUID())
            .send(body);

    const outboxTypes = async () => db(REGION)("events_outbox").orderBy("id").pluck("event_type");

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
        customerSocket?.disconnect();
        customerSocket = undefined;
    });

    it("accepts a placed order, writes the outbox event and pushes the change to the customer", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "placed"});
        customerSocket = await connectAs(app.baseUrl, CUSTOMER);
        await subscribe(customerSocket, `customer:${CUSTOMER.userId}`);
        const pushed = nextEvent(customerSocket, "order.status_changed");

        // Act
        const res = await patchStatus(restaurantUrl(order.public_id), RESTAURANT_OWNER, {status: "accepted"});

        // Assert — HTTP contract
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            publicId: order.public_id,
            status: "accepted",
            updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        });

        // Assert — persisted state
        const row = await db(REGION)("orders").where({public_id: order.public_id}).first("status", "accepted_at");
        expect(row.status).toBe("accepted");
        expect(row.accepted_at).toBeInstanceOf(Date);

        const outbox = await db(REGION)("events_outbox").select("event_type", "aggregate_id");
        expect(outbox).toEqual([{event_type: "order.accepted", aggregate_id: order.public_id}]);

        // Assert — live update reached the customer's channel
        await expect(pushed).resolves.toEqual(res.body.data);
    });

    it("refuses a transition the status machine does not allow and leaves the order untouched", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "placed"});

        // Act — placed cannot jump straight to ready
        const res = await patchStatus(restaurantUrl(order.public_id), RESTAURANT_OWNER, {status: "ready"});

        // Assert
        expect(res.status).toBe(409);
        expect(res.body).toEqual({error: "InvalidStatusTransition: placed -> ready"});

        const row = await db(REGION)("orders").where({public_id: order.public_id}).first("status", "ready_at");
        expect(row).toEqual({status: "placed", ready_at: null});
        expect(await outboxTypes()).toEqual([]);
    });

    it("rejects a status change without an Idempotency-Key header", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "placed"});

        // Act
        const res = await request(app.server)
            .patch(restaurantUrl(order.public_id))
            .set("X-Region", REGION)
            .set("Cookie", authCookie(RESTAURANT_OWNER))
            .send({status: "accepted"});

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toEqual({error: "Missing Idempotency-Key header"});

        const row = await db(REGION)("orders").where({public_id: order.public_id}).first("status");
        expect(row.status).toBe("placed");
    });

    it("lets the customer cancel inside the window and hands the reserved stock back to core", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "placed"});
        await insertOrderItem(REGION, order.id, {product_id: 501, quantity: 2});

        // Act
        const res = await patchStatus(`/api/customer/orders/${order.public_id}/status`, CUSTOMER, {status: "cancelled", reason: "ordered by mistake"});

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("cancelled");
        expect(await outboxTypes()).toEqual(["order.cancelled"]);

        const [release] = app.core.callsTo("POST", `/api/internal/branches/${BRANCH_ID}/release-stock`);
        expect(release.body).toEqual({items: [{productId: 501, quantity: 2}]});
        expect(release.headers["idempotency-key"]).toBe(`release:${order.public_id}`);
    });

    it("lets the restaurant reject a placed order with a reason", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "placed"});
        await insertOrderItem(REGION, order.id);

        // Act
        const res = await patchStatus(restaurantUrl(order.public_id), RESTAURANT_OWNER, {status: "rejected", reason: "out of ingredients"});

        // Assert
        expect(res.status).toBe(200);
        const row = await db(REGION)("orders").where({id: order.id}).first("status", "rejected_at");
        expect(row.status).toBe("rejected");
        expect(row.rejected_at).toBeInstanceOf(Date);
        expect(await outboxTypes()).toEqual(["order.rejected"]);
        expect(app.core.callsTo("POST", "/api/internal/branches/20/release-stock")).toHaveLength(1);
    });

    it("keeps the stock consumed when an admin cancels an order the kitchen already started", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "preparing"});

        // Act
        const res = await patchStatus(`/api/admin/orders/${order.public_id}/status`, ADMIN, {status: "cancelled", reason: "customer unreachable"});

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("cancelled");
        expect(app.core.callsTo("POST", "/api/internal/branches/20/release-stock")).toHaveLength(0);
    });

    it("forbids members of another restaurant from changing the order", async () => {
        // Arrange
        const order = await insertOrder(REGION, {status: "placed"});

        // Act
        const res = await patchStatus(restaurantUrl(order.public_id), OTHER_RESTAURANT_OWNER, {status: "accepted"});

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toEqual({error: "Permission denied"});
    });

    it("returns 404 for an unknown order", async () => {
        // Arrange
        const unknown = randomUUID();

        // Act
        const res = await patchStatus(restaurantUrl(unknown), RESTAURANT_OWNER, {status: "accepted"});

        // Assert
        expect(res.status).toBe(404);
        expect(res.body).toEqual({error: "OrderNotFound"});
    });
});
