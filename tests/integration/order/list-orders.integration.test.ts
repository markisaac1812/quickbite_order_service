import "reflect-metadata";
import {randomUUID} from "crypto";
import request from "supertest";
import {startTestServer} from "../../helpers/server";
import {insertOrder, insertOrderItem} from "../../helpers/factories";
import {
    authCookie,
    BRANCH_STAFF,
    CUSTOMER,
    OTHER_BRANCH_STAFF,
    OTHER_CUSTOMER,
    OTHER_RESTAURANT_OWNER,
    RESTAURANT_OWNER,
} from "../../helpers/auth";
import {OTHER_BRANCH_ID} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";

const REGION = "eg";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

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

describe("GET /api/customer/orders", () => {
    it("pages the customer's own orders newest-first with a created_at cursor", async () => {
        // Arrange
        const oldest = await insertOrder(REGION, {created_at: minutesAgo(3)});
        const middle = await insertOrder(REGION, {created_at: minutesAgo(2)});
        const newest = await insertOrder(REGION, {created_at: minutesAgo(1)});
        await insertOrderItem(REGION, newest.id);
        await insertOrder(REGION, {customer_id: OTHER_CUSTOMER.userId});

        // Act
        const page1 = await request(app.server).get("/api/customer/orders?limit=2").set("X-Region", REGION).set("Cookie", authCookie(CUSTOMER));
        const page2 = await request(app.server)
            .get(`/api/customer/orders?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(CUSTOMER));

        // Assert
        expect(page1.status).toBe(200);
        expect(page1.body.data.map((o: {publicId: string}) => o.publicId)).toEqual([newest.public_id, middle.public_id]);
        expect(page1.body.data[0].itemsCount).toBe(1);
        expect(page1.body.meta).toEqual({nextCursor: middle.created_at.toISOString(), hasMore: true, count: 2});

        expect(page2.body.data.map((o: {publicId: string}) => o.publicId)).toEqual([oldest.public_id]);
        expect(page2.body.meta).toEqual({nextCursor: null, hasMore: false, count: 1});
    });

    it("merges archived and not-yet-archived orders for a prior year", async () => {
        // Arrange
        const lastYear = new Date().getUTCFullYear() - 1;
        const archived = await insertOrder(REGION, {id: 5000, status: "delivered", created_at: new Date(Date.UTC(lastYear, 2, 1, 12))}, "archive");
        await insertOrderItem(REGION, archived.id, {}, "archive");
        const stillHot = await insertOrder(REGION, {status: "delivered", created_at: new Date(Date.UTC(lastYear, 11, 30, 12))});
        await insertOrder(REGION, {created_at: minutesAgo(1)}); // current year — out of range

        // Act
        const res = await request(app.server)
            .get(`/api/customer/orders?year=${lastYear}`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(CUSTOMER));

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data.map((o: {publicId: string}) => o.publicId)).toEqual([stillHot.public_id, archived.public_id]);
        expect(res.body.data[1].itemsCount).toBe(1);
    });

    it("requires a region and an authenticated user", async () => {
        // Arrange
        const url = "/api/customer/orders";

        // Act
        const noRegion = await request(app.server).get(url).set("Cookie", authCookie(CUSTOMER));
        const noUser = await request(app.server).get(url).set("X-Region", REGION);
        const badToken = await request(app.server).get(url).set("X-Region", REGION).set("Cookie", "access_token=not-a-jwt");

        // Assert
        expect(noRegion.status).toBe(400);
        expect(noUser.status).toBe(401);
        expect(noUser.body).toEqual({error: "User not authenticated"});
        expect(badToken.status).toBe(401);
    });
});

describe("GET /api/restaurants/:restaurantId/branches/:branchId/orders", () => {
    const url = "/api/restaurants/10/branches/20/orders";
    const listBranchOrders = (status: string) =>
        request(app.server).get(`${url}?status=${status}`).set("X-Region", REGION).set("Cookie", authCookie(RESTAURANT_OWNER));

    it("lists the branch's orders filtered by status and serves the repeat read from cache", async () => {
        // Arrange
        const placed = await insertOrder(REGION, {status: "placed"});
        await insertOrder(REGION, {status: "accepted"});
        await insertOrder(REGION, {status: "placed", branch_id: OTHER_BRANCH_ID});

        // Act
        const first = await request(app.server).get(`${url}?status=placed`).set("X-Region", REGION).set("Cookie", authCookie(RESTAURANT_OWNER));
        const second = await request(app.server).get(`${url}?status=placed`).set("X-Region", REGION).set("Cookie", authCookie(RESTAURANT_OWNER));

        // Assert
        expect(first.status).toBe(200);
        expect(first.body.data.map((o: {publicId: string}) => o.publicId)).toEqual([placed.public_id]);
        expect(first.headers["x-cache"]).toBe("MISS");
        expect(second.headers["x-cache"]).toBe("HIT");
        expect(second.body).toEqual(first.body);
        // owner permissions were fetched from core once and then cached in-process
        expect(app.core.callsTo("GET", "/api/internal/rbac/permissions")).toHaveLength(1);
    });

    it("drops every cached variant of the branch list when an order changes status", async () => {
        // Arrange — two filter variants of the list are cached
        const order = await insertOrder(REGION, {status: "placed"});
        await listBranchOrders("placed");
        await listBranchOrders("accepted");
        const primed = await listBranchOrders("placed");

        // Act
        await request(app.server)
            .patch(`${url}/${order.public_id}/status`)
            .set("X-Region", REGION)
            .set("Cookie", authCookie(RESTAURANT_OWNER))
            .set("Idempotency-Key", randomUUID())
            .send({status: "accepted"});
        const placed = await listBranchOrders("placed");
        const accepted = await listBranchOrders("accepted");

        // Assert
        expect(primed.headers["x-cache"]).toBe("HIT");
        expect(placed.headers["x-cache"]).toBe("MISS");
        expect(placed.body.data).toEqual([]);
        expect(accepted.headers["x-cache"]).toBe("MISS");
        expect(accepted.body.data.map((o: {publicId: string}) => o.publicId)).toEqual([order.public_id]);
    });

    it("shows a newly placed order straight away instead of the cached list", async () => {
        // Arrange — the empty list is cached
        await listBranchOrders("placed");

        // Act
        await request(app.server)
            .post("/api/orders")
            .set("X-Region", REGION)
            .set("Cookie", authCookie(CUSTOMER))
            .set("Idempotency-Key", randomUUID())
            .send({branchId: 20, customerAddressId: 30, paymentMethod: "cod", items: [{productId: 501, quantity: 1}]});
        const after = await listBranchOrders("placed");

        // Assert
        expect(after.headers["x-cache"]).toBe("MISS");
        expect(after.body.data).toHaveLength(1);
    });

    it("lets branch staff with orders:read see their branch", async () => {
        // Arrange
        await insertOrder(REGION);

        // Act
        const res = await request(app.server).get(url).set("X-Region", REGION).set("Cookie", authCookie(BRANCH_STAFF));

        // Assert
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });

    it("forbids staff assigned to a different branch", async () => {
        // Arrange
        await insertOrder(REGION);

        // Act
        const res = await request(app.server).get(url).set("X-Region", REGION).set("Cookie", authCookie(OTHER_BRANCH_STAFF));

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toEqual({error: "You do not have access to this branch"});
    });

    it("forbids members of another restaurant", async () => {
        // Arrange
        await insertOrder(REGION);

        // Act
        const res = await request(app.server).get(url).set("X-Region", REGION).set("Cookie", authCookie(OTHER_RESTAURANT_OWNER));

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toEqual({error: "Permission denied"});
    });

    it("forbids a restaurant role whose permissions in core lack orders:read", async () => {
        // Arrange
        app.core.permissions.set("staff", []);

        // Act
        const res = await request(app.server).get(url).set("X-Region", REGION).set("Cookie", authCookie(BRANCH_STAFF));

        // Assert
        expect(res.status).toBe(403);
        expect(res.body).toEqual({error: "Permission denied"});
    });

    it("forbids non-restaurant roles", async () => {
        // Arrange — customers are not restaurant members (restaurantId is absent)

        // Act
        const res = await request(app.server).get(url).set("X-Region", REGION).set("Cookie", authCookie(CUSTOMER));

        // Assert
        expect(res.status).toBe(403);
    });
});
