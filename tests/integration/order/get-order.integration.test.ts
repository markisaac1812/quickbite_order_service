import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import {startTestServer} from "../../helpers/server";
import {insertOrder, insertOrderItem} from "../../helpers/factories";
import {authCookie, CUSTOMER, OTHER_CUSTOMER, RESTAURANT_OWNER} from "../../helpers/auth";
import {TestServer} from "../../helpers/types";

const REGION = "eg";

describe("GET /api/orders/:publicId", () => {
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

    it("returns the order detail DTO to the customer who placed it", async () => {
        // Arrange
        const order = await insertOrder(REGION, {customer_id: CUSTOMER.userId});
        await insertOrderItem(REGION, order.id, {
            product_id: 501,
            name_snapshot: "Koshary (large)",
            quantity: 2,
            unit_price_snapshot: 7500,
            line_total: 15000,
        });

        // Act
        const res = await request(app.server)
            .get(`/api/orders/${order.public_id}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(CUSTOMER));

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual({
            publicId: order.public_id,
            status: "placed",
            paymentMethod: "cod",
            branch: {id: 20},
            restaurant: {id: 10},
            customerAddress: {lat: 30.0444, lng: 31.2357, addressText: "12 Tahrir St, Cairo"},
            subtotal: 15000,
            deliveryFee: 2000,
            serviceFee: 1000,
            total: 18000,
            currency: "EGP",
            items: [{productId: 501, name: "Koshary (large)", imageUrl: null, quantity: 2, unitPrice: 7500, lineTotal: 15000}],
            createdAt: order.created_at.toISOString(),
            history: [{status: "placed", ts: order.created_at.toISOString()}],
        });
    });

    it("forbids a customer from reading another customer's order", async () => {
        // Arrange
        const order = await insertOrder(REGION, {customer_id: CUSTOMER.userId});

        // Act
        const res = await request(app.server)
            .get(`/api/orders/${order.public_id}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(OTHER_CUSTOMER));

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toEqual({error: "User not authorised"});
    });

    it("returns 404 for an order that does not exist on the shard", async () => {
        // Arrange
        const unknownPublicId = randomUUID();

        // Act
        const res = await request(app.server)
            .get(`/api/orders/${unknownPublicId}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(CUSTOMER));

        // Assert
        expect(res.status).toBe(404);
        expect(res.body).toEqual({error: "OrderNotFound"});
    });

    it("falls back to the archive cluster for the restaurant owner", async () => {
        // Arrange — a prior-year order that the archival worker already moved
        const lastYear = new Date().getUTCFullYear() - 1;
        const archived = await insertOrder(REGION, {id: 7000, status: "delivered", created_at: new Date(Date.UTC(lastYear, 5, 1))}, "archive");
        await insertOrderItem(REGION, archived.id, {name_snapshot: "Archived dish"}, "archive");

        // Act
        const res = await request(app.server)
            .get(`/api/orders/${archived.public_id}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(RESTAURANT_OWNER));

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({publicId: archived.public_id, status: "delivered", items: [{name: "Archived dish"}]});
    });

    it("never reads the archive on the customer tracking path", async () => {
        // Arrange
        const archived = await insertOrder(REGION, {id: 7001, created_at: new Date(Date.UTC(2020, 0, 5))}, "archive");

        // Act
        const res = await request(app.server)
            .get(`/api/orders/${archived.public_id}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(CUSTOMER));

        // Assert
        expect(res.status).toBe(404);
    });

    it("refuses the admin fan-out region on a single-order lookup", async () => {
        // Arrange
        const order = await insertOrder(REGION);

        // Act
        const res = await request(app.server)
            .get(`/api/orders/${order.public_id}`)
            .set("X-Region", "all")
            .set("Cookie", authCookie(CUSTOMER));

        // Assert
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/^Region not resolved/);
    });
});
