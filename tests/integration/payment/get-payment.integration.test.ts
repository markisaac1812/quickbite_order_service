import "reflect-metadata";
import request from "supertest";
import {startTestServer} from "../../helpers/server";
import {insertOrder, insertTransaction} from "../../helpers/factories";
import {authCookie, RESTAURANT_OWNER} from "../../helpers/auth";
import {OTHER_RESTAURANT_ID, OWNER_ID, RESTAURANT_ID} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";

const REGION = "eg";
const paymentUrl = (paymentId: number | string) => `/api/restaurants/${RESTAURANT_ID}/payments/${paymentId}`;

describe("GET /api/restaurants/:restaurantId/payments/:paymentId", () => {
    let app: TestServer;

    const get = (path: string) => request(app.server).get(path).set("X-Region", REGION).set("Cookie", authCookie(RESTAURANT_OWNER));

    beforeAll(async () => {
        app = await startTestServer();
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("returns a payment on one of the restaurant's orders", async () => {
        // Arrange
        const order = await insertOrder(REGION);
        const paymentId = await insertTransaction(REGION, {order_id: order.id, provider_reference_id: "TX-9001"});

        // Act
        const res = await get(paymentUrl(paymentId));

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            id: paymentId,
            orderId: order.id,
            type: "charge",
            method: "online",
            provider: "kashier",
            providerReferenceId: "TX-9001",
            status: "succeeded",
            amount: 18000,
            currency: "EGP",
            isRefunded: false,
        });
    });

    it("returns ledger rows that are not tied to an order (payouts)", async () => {
        // Arrange
        const payoutId = await insertTransaction(REGION, {transaction_type: "payout", method: "bank_transfer", provider_id: null, dst_acc_id: OWNER_ID});

        // Act
        const res = await get(paymentUrl(payoutId));

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({orderId: null, type: "payout", provider: null});
    });

    it("forbids peeking at another restaurant's payment by id", async () => {
        // Arrange
        const foreignOrder = await insertOrder(REGION, {restaurant_id: OTHER_RESTAURANT_ID});
        const foreignPayment = await insertTransaction(REGION, {order_id: foreignOrder.id});

        // Act
        const res = await get(paymentUrl(foreignPayment));

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toEqual({error: "User not authorised"});
    });

    it("404s unknown payments and 400s malformed ids", async () => {
        // Arrange
        const unknownId = 424242;

        // Act
        const unknown = await get(paymentUrl(unknownId));
        const malformed = await get(paymentUrl("abc"));

        // Assert
        expect(unknown.status).toBe(404);
        expect(unknown.body).toEqual({error: "PaymentNotFound"});
        expect(malformed.status).toBe(400);
        expect(malformed.body).toEqual({error: "invalid paymentId"});
    });
});
