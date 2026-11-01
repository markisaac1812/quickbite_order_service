import "reflect-metadata";
import request from "supertest";
import {db} from "../../../src/lib/knex/knex";
import {env} from "../../../src/lib/config/env";
import {computeWebhookSignature} from "../../../src/pkg/payments/kashier/kashier.signature";
import {startTestServer} from "../../helpers/server";
import {insertOrder, insertOrderItem, insertPaymentSession} from "../../helpers/factories";
import {authCookie, RESTAURANT_OWNER} from "../../helpers/auth";
import {TestServer} from "../../helpers/types";

const REGION = "eg";
const WEBHOOK_URL = `/api/payments/webhook/kashier?region=${REGION}`;

/** A Kashier webhook envelope as it arrives on the wire. */
function kashierWebhook(merchantOrderId: string, transactionId: string, overrides: {event?: string; status?: string} = {}) {
    return {
        event: overrides.event ?? "pay",
        data: {
            merchantOrderId,
            kashierOrderId: "KO-7781",
            orderReference: "TEST-ORD-42",
            transactionId,
            status: overrides.status ?? "SUCCESS",
            method: "card",
            amount: 180,
            currency: "EGP",
            signatureKeys: ["amount", "currency", "kashierOrderId", "merchantOrderId", "orderReference", "status", "transactionId"],
        },
    };
}

/** Signs the envelope the way Kashier does (HMAC over signatureKeys with our API key). */
function kashierSignature(envelope: ReturnType<typeof kashierWebhook>): string {
    return computeWebhookSignature(envelope.data, envelope.data.signatureKeys, env.kashier.apiKey);
}

async function seedOnlineOrderAwaitingPayment(status = "pending_payment") {
    const order = await insertOrder(REGION, {status, payment_method: "online", total: 18000});
    await insertOrderItem(REGION, order.id);
    await insertPaymentSession(REGION, order.id, {amount: 18000, currency: "EGP", status: "initialized"});
    return order;
}

describe("POST /api/payments/webhook/kashier", () => {
    let app: TestServer;

    const deliver = (envelope: ReturnType<typeof kashierWebhook>, signature = kashierSignature(envelope)) =>
        request(app.server).post(WEBHOOK_URL).set("x-kashier-signature", signature).send(envelope);

    const count = async (table: string) => Number((await db(REGION)(table).count<{count: string}[]>("* as count"))[0].count);

    beforeAll(async () => {
        app = await startTestServer();
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("captures the payment and places the order on a valid SUCCESS webhook", async () => {
        // Arrange
        const order = await seedOnlineOrderAwaitingPayment();
        const envelope = kashierWebhook(order.public_id, "TX-1001");

        // Act
        const res = await deliver(envelope);

        // Assert
        expect(res.status).toBe(200);
        expect(res.body).toEqual({success: true});

        const conn = db(REGION);
        const orderRow = await conn("orders").where({id: order.id}).first("status");
        expect(orderRow.status).toBe("placed");

        const session = await conn("payment_sessions").where({order_id: order.id}).first("status");
        expect(session.status).toBe("captured");

        const transactions = await conn("transactions").select(
            "transaction_type", "method", "status", "amount", "currency", "provider_reference_id", "idempotency_key",
        );
        expect(transactions).toEqual([{
            transaction_type: "charge",
            method: "online",
            status: "succeeded",
            amount: 18000,
            currency: "EGP",
            provider_reference_id: "TX-1001",
            idempotency_key: "kashier:TX-1001",
        }]);

        const webhookEvent = await conn("payment_webhook_events").first("provider_event_id", "processed_at", "process_error");
        expect(webhookEvent).toEqual({provider_event_id: "TX-1001", processed_at: expect.any(Date), process_error: null});

        const outbox = await conn("events_outbox").orderBy("id").pluck("event_type");
        expect(outbox).toEqual(["payment.completed", "order.placed"]);
    });

    it("makes the captured order visible in the restaurant's cached order list", async () => {
        // Arrange — the branch dashboard has the (still empty) placed list cached
        const order = await seedOnlineOrderAwaitingPayment();
        const listPlaced = () =>
            request(app.server).get("/api/restaurants/10/branches/20/orders?status=placed").set("X-Region", REGION).set("Cookie", authCookie(RESTAURANT_OWNER));
        const before = await listPlaced();

        // Act
        await deliver(kashierWebhook(order.public_id, "TX-9009"));
        const after = await listPlaced();

        // Assert
        expect(before.body.data).toEqual([]);
        expect(after.headers["x-cache"]).toBe("MISS");
        expect(after.body.data.map((o: {publicId: string}) => o.publicId)).toEqual([order.public_id]);
    });

    it("treats a replayed webhook as a no-op", async () => {
        // Arrange
        const order = await seedOnlineOrderAwaitingPayment();
        const envelope = kashierWebhook(order.public_id, "TX-2002");
        await deliver(envelope);

        // Act — Kashier retries the exact same delivery
        const replay = await deliver(envelope);

        // Assert
        expect(replay.status).toBe(200);
        expect(await count("transactions")).toBe(1);
        expect(await count("payment_webhook_events")).toBe(1);
    });

    it("rejects a webhook with an invalid signature and records nothing", async () => {
        // Arrange
        const order = await seedOnlineOrderAwaitingPayment();
        const envelope = kashierWebhook(order.public_id, "TX-3003");
        const signedForAnotherAmount = kashierSignature({...envelope, data: {...envelope.data, amount: 1}});

        // Act
        const res = await deliver(envelope, signedForAnotherAmount);

        // Assert
        expect(res.status).toBe(401);
        expect(res.body).toEqual({error: "InvalidSignature"});

        const orderRow = await db(REGION)("orders").where({id: order.id}).first("status");
        expect(orderRow.status).toBe("pending_payment");
        expect(await count("payment_webhook_events")).toBe(0);
    });

    it("records a FAILED charge for audit and leaves the order awaiting payment", async () => {
        // Arrange
        const order = await seedOnlineOrderAwaitingPayment();
        const envelope = kashierWebhook(order.public_id, "TX-4004", {status: "FAILED"});

        // Act
        const res = await deliver(envelope);

        // Assert
        expect(res.status).toBe(200);
        const conn = db(REGION);
        expect((await conn("orders").where({id: order.id}).first("status")).status).toBe("pending_payment");
        expect((await conn("payment_sessions").first("status")).status).toBe("failed");
        const tx = await conn("transactions").first("status", "dst_acc_id");
        expect(tx).toEqual({status: "failed", dst_acc_id: null});
        expect(await conn("events_outbox").pluck("event_type")).toEqual(["payment.failed"]);
    });

    it("does not re-place an order that is already placed", async () => {
        // Arrange — e.g. a capture that arrives after the order moved on
        const order = await seedOnlineOrderAwaitingPayment("placed");
        const envelope = kashierWebhook(order.public_id, "TX-5005");

        // Act
        const res = await deliver(envelope);

        // Assert
        expect(res.status).toBe(200);
        expect(await db(REGION)("events_outbox").pluck("event_type")).toEqual(["payment.completed"]);
        expect((await db(REGION)("payment_sessions").first("status")).status).toBe("captured");
    });

    it("acknowledges, but does not act on, events other than pay", async () => {
        // Arrange
        const order = await seedOnlineOrderAwaitingPayment();
        const envelope = kashierWebhook(order.public_id, "TX-6006", {event: "refund"});

        // Act
        const res = await deliver(envelope);

        // Assert
        expect(res.status).toBe(200);
        expect(await count("transactions")).toBe(0);
        const event = await db(REGION)("payment_webhook_events").first("processed_at", "process_error");
        expect(event).toEqual({processed_at: expect.any(Date), process_error: null});
    });

    it("acknowledges webhooks for unknown orders or orders without an active session", async () => {
        // Arrange
        const orderWithoutSession = await insertOrder(REGION, {status: "pending_payment", payment_method: "online"});
        const unknown = kashierWebhook("00000000-0000-4000-8000-000000000000", "TX-7007");
        const noSession = kashierWebhook(orderWithoutSession.public_id, "TX-7008");

        // Act
        const unknownRes = await deliver(unknown);
        const noSessionRes = await deliver(noSession);

        // Assert
        expect([unknownRes.status, noSessionRes.status]).toEqual([200, 200]);
        expect(await count("transactions")).toBe(0);
        expect(await count("payment_webhook_events")).toBe(2);
    });

    it("rejects malformed envelopes, a missing signature header and a missing region", async () => {
        // Arrange
        const order = await seedOnlineOrderAwaitingPayment();
        const envelope = kashierWebhook(order.public_id, "TX-8008");
        const {signatureKeys: _dropped, ...dataWithoutKeys} = envelope.data;

        // Act
        const malformed = await request(app.server).post(WEBHOOK_URL).set("x-kashier-signature", "abc").send({event: "pay", data: dataWithoutKeys});
        const unsigned = await request(app.server).post(WEBHOOK_URL).send(envelope);
        const noRegion = await request(app.server).post("/api/payments/webhook/kashier").set("x-kashier-signature", kashierSignature(envelope)).send(envelope);

        // Assert
        expect(malformed.status).toBe(400);
        expect(malformed.body).toEqual({error: "MalformedWebhook"});
        expect(unsigned.status).toBe(401);
        expect(noRegion.status).toBe(400);
        expect(await count("payment_webhook_events")).toBe(0);
    });
});
