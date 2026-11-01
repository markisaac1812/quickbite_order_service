import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import {db} from "../../../src/lib/knex/knex";
import {startTestServer} from "../../helpers/server";
import {insertBalance, insertOrder, insertTransaction} from "../../helpers/factories";
import {ADMIN, authCookie, BRANCH_STAFF, RESTAURANT_OWNER} from "../../helpers/auth";
import {OTHER_RESTAURANT_ID, OWNER_ID, RESTAURANT_ID} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";
import type {JWTPayload} from "../../../src/lib/auth/jwt";

const REGION = "eg";

describe("restaurant finance (balance, payouts)", () => {
    let app: TestServer;

    const get = (path: string, user: JWTPayload) =>
        request(app.server).get(path).set("X-Region", REGION).set("Cookie", authCookie(user));

    const createPayout = (restaurantId: number, body: object, user: JWTPayload = ADMIN, key: string = randomUUID()) =>
        request(app.server)
            .post(`/api/admin/restaurants/${restaurantId}/payouts`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(user))
            .set("Idempotency-Key", key)
            .send(body);

    const balanceOf = async (restaurantId: number) =>
        (await db(REGION)("restaurant_balances").where({restaurant_id: restaurantId}).first("balance"))?.balance;

    beforeAll(async () => {
        app = await startTestServer();
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("shows the owner the running balance per currency", async () => {
        // Arrange
        await insertBalance(REGION, {balance: 50000});

        // Act
        const res = await get(`/api/restaurants/${RESTAURANT_ID}/balance`, RESTAURANT_OWNER);

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({restaurantId: 10, balances: [{currency: "EGP", balance: 50000}], asOf: expect.stringMatching(/Z$/)});
    });

    it("records an admin payout and debits the balance", async () => {
        // Arrange
        await insertOrder(REGION); // snapshots restaurant_owner_id = 100
        await insertBalance(REGION, {balance: 50000});
        const key = randomUUID();

        // Act
        const res = await createPayout(RESTAURANT_ID, {amount: 20000, currency: "EGP", providerReferenceId: "BANK-REF-1"}, ADMIN, key);

        // Assert
        expect(res.status).toBe(201);
        expect(res.body.data).toEqual({
            id: 1,
            amount: 20000,
            currency: "EGP",
            status: "succeeded",
            providerReferenceId: "BANK-REF-1",
            createdAt: expect.stringMatching(/Z$/),
        });
        expect(await balanceOf(RESTAURANT_ID)).toBe(30000);
        const payout = await db(REGION)("transactions").first("transaction_type", "method", "dst_acc_id", "idempotency_key");
        expect(payout).toEqual({transaction_type: "payout", method: "bank_transfer", dst_acc_id: String(OWNER_ID), idempotency_key: key});
    });

    it("refuses a payout larger than the balance and leaves it untouched", async () => {
        // Arrange
        await insertOrder(REGION);
        await insertBalance(REGION, {balance: 5000});

        // Act
        const res = await createPayout(RESTAURANT_ID, {amount: 20000, currency: "EGP", providerReferenceId: "BANK-REF-2"});

        // Assert
        expect(res.status).toBe(409);
        expect(res.body).toEqual({error: "InsufficientBalance"});
        expect(await balanceOf(RESTAURANT_ID)).toBe(5000);
        expect(await db(REGION)("transactions").count<{count: string}[]>("* as count")).toEqual([{count: "0"}]);
    });

    it("404s a payout for a restaurant with no orders on this shard", async () => {
        // Arrange — no order row → no owner id to pay

        // Act
        const res = await createPayout(OTHER_RESTAURANT_ID, {amount: 100, currency: "EGP", providerReferenceId: "BANK-REF-3"});

        // Assert
        expect(res.status).toBe(404);
        expect(res.body).toEqual({error: "RestaurantNotFound"});
    });

    it("validates the payout body", async () => {
        // Arrange
        const body = {amount: 0, currency: "EGP", providerReferenceId: "BANK-REF-4"};

        // Act
        const res = await createPayout(RESTAURANT_ID, body);

        // Assert
        expect(res.status).toBe(400);
        expect(res.body).toEqual({error: "amount must be a positive number"});
    });

    it("lists the owner's payouts for the default window", async () => {
        // Arrange
        await insertOrder(REGION);
        await insertTransaction(REGION, {transaction_type: "payout", method: "bank_transfer", provider_id: null, provider_reference_id: "BANK-REF-5", amount: 7000, src_acc_id: null, dst_acc_id: OWNER_ID});
        await insertTransaction(REGION, {transaction_type: "charge", dst_acc_id: OWNER_ID}); // not a payout

        // Act
        const res = await get(`/api/restaurants/${RESTAURANT_ID}/payouts`, RESTAURANT_OWNER);

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([expect.objectContaining({amount: 7000, providerReferenceId: "BANK-REF-5"})]);
    });

    it("returns no payouts for a restaurant without orders and honours from/to", async () => {
        // Arrange
        await insertOrder(REGION);
        await insertTransaction(REGION, {transaction_type: "payout", method: "bank_transfer", dst_acc_id: OWNER_ID, created_at: new Date("2026-01-15T10:00:00.000Z")});

        // Act
        const outsideWindow = await get(`/api/restaurants/${RESTAURANT_ID}/payouts?from=2026-02-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z`, RESTAURANT_OWNER);
        const noOrders = await get(`/api/restaurants/${OTHER_RESTAURANT_ID}/payouts`, ADMIN);

        // Assert
        expect(outsideWindow.body.data).toEqual([]);
        expect(noOrders.body.data).toEqual([]);
    });

    it("keeps finance away from staff and payouts away from owners", async () => {
        // Arrange — staff role has only orders:read; owners lack finance:payout_create
        await insertBalance(REGION);

        // Act
        const staffBalance = await get(`/api/restaurants/${RESTAURANT_ID}/balance`, BRANCH_STAFF);
        const ownerPayout = await createPayout(RESTAURANT_ID, {amount: 100, currency: "EGP", providerReferenceId: "BANK-REF-6"}, RESTAURANT_OWNER);

        // Assert
        expect(staffBalance.status).toBe(403);
        expect(ownerPayout.status).toBe(403);
        expect(ownerPayout.body).toEqual({error: "Permission denied"});
    });
});
