import "reflect-metadata";
import {redisClient} from "../../../src/lib/cache/init";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {env} from "../../../src/lib/config/env";
import {getBranch, getBranchesByIds, getBranchProducts, releaseStock, reserveStock} from "../../../src/lib/core-client/branch.client";
import {getCustomerAddress} from "../../../src/lib/core-client/address.client";
import {getPermissionsByRole} from "../../../src/lib/core-client/rbac.client";
import {PermissionCacheService} from "../../../src/lib/rbac/permission-cache.service";
import {startTestServer} from "../../helpers/server";
import {ADDRESS_ID, BRANCH_ID, branchFixture, OTHER_BRANCH_ID, productsFixture} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";

const branchPath = `/api/internal/branches/${BRANCH_ID}`;

describe("core-service client (read-through cache over real HTTP)", () => {
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

    describe("branches", () => {
        it("fetches a branch once and serves repeats from Redis", async () => {
            // Arrange
            await getBranch(BRANCH_ID);

            // Act
            const again = await getBranch(BRANCH_ID);

            // Assert
            expect(again).toEqual(branchFixture());
            expect(app.core.callsTo("GET", branchPath)).toHaveLength(1);
            expect(await redisClient.ttl(`core:branch:${BRANCH_ID}`)).toBeGreaterThan(3500);
        });

        it("refetches when the cached entry is corrupt", async () => {
            // Arrange
            await redisClient.set(`core:branch:${BRANCH_ID}`, "{corrupt");

            // Act
            const branch = await getBranch(BRANCH_ID);

            // Assert
            expect(branch.id).toBe(BRANCH_ID);
            expect(app.core.callsTo("GET", branchPath)).toHaveLength(1);
        });

        it("batches only the cache misses into a single core call", async () => {
            // Arrange
            await redisClient.set(`core:branch:${BRANCH_ID}`, JSON.stringify(branchFixture()));
            app.core.branches.set(OTHER_BRANCH_ID, branchFixture({id: OTHER_BRANCH_ID, name: "Zamalek"}));

            // Act
            const map = await getBranchesByIds([BRANCH_ID, OTHER_BRANCH_ID, OTHER_BRANCH_ID]);
            const empty = await getBranchesByIds([]);

            // Assert
            expect([...map.keys()].sort()).toEqual([BRANCH_ID, OTHER_BRANCH_ID]);
            expect(map.get(OTHER_BRANCH_ID)?.name).toBe("Zamalek");
            expect(app.core.calls.map((c) => c.path)).toEqual([`/api/internal/branches?ids=${OTHER_BRANCH_ID}`]);
            expect(empty.size).toBe(0);
        });

        it("skips the network entirely when every branch is cached", async () => {
            // Arrange
            await redisClient.set(`core:branch:${BRANCH_ID}`, JSON.stringify(branchFixture()));

            // Act
            const map = await getBranchesByIds([BRANCH_ID]);

            // Assert
            expect(map.get(BRANCH_ID)?.name).toBe("Downtown");
            expect(app.core.calls).toHaveLength(0);
        });
    });

    describe("branch products", () => {
        it("treats event-merged partial entries as misses and fetches only those", async () => {
            // Arrange — 501 fully cached; 502 only has what a price event wrote
            const [koshary] = productsFixture();
            await redisClient.set(`core:branch:${BRANCH_ID}:product:501`, JSON.stringify(koshary));
            await redisClient.set(`core:branch:${BRANCH_ID}:product:502`, JSON.stringify({productId: 502, price: 1250}));

            // Act
            const products = await getBranchProducts(BRANCH_ID, [501, 502]);

            // Assert
            expect(products.map((p) => p.productId).sort()).toEqual([501, 502]);
            expect(app.core.calls.map((c) => c.path)).toEqual([`/api/internal/branches/${BRANCH_ID}/products?ids=502`]);
            const refreshed = JSON.parse((await redisClient.get(`core:branch:${BRANCH_ID}:product:502`))!);
            expect(refreshed.name).toBe("Mint tea");
        });

        it("answers from cache alone when every product is fully cached, and ignores corrupt entries", async () => {
            // Arrange
            const [koshary] = productsFixture();
            await redisClient.set(`core:branch:${BRANCH_ID}:product:501`, JSON.stringify(koshary));
            await redisClient.set(`core:branch:${BRANCH_ID}:product:502`, "{corrupt");

            // Act
            const cachedOnly = await getBranchProducts(BRANCH_ID, [501]);
            const withCorrupt = await getBranchProducts(BRANCH_ID, [502]);
            const none = await getBranchProducts(BRANCH_ID, []);

            // Assert
            expect(cachedOnly).toEqual([koshary]);
            expect(withCorrupt.map((p) => p.productId)).toEqual([502]);
            expect(none).toEqual([]);
            expect(app.core.calls).toHaveLength(1);
        });
    });

    describe("request plumbing", () => {
        it("sends the internal api-key and forwards correlation + idempotency headers", async () => {
            // Arrange
            const items = [{productId: 501, quantity: 2}];

            // Act
            const reserved = await reserveStock(BRANCH_ID, items, "reserve-key", "corr-123");
            await releaseStock(BRANCH_ID, items, "release-key");

            // Assert
            expect(reserved).toEqual({ok: true, applied: [{productId: 501, newStock: 0}]});
            const [reserveCall, releaseCall] = app.core.calls;
            expect(reserveCall.headers["api-key"]).toBe(env.core.internalApiKey);
            expect(reserveCall.headers["x-correlationid"]).toBe("corr-123");
            expect(reserveCall.headers["idempotency-key"]).toBe("reserve-key");
            expect(releaseCall.path).toBe(`/api/internal/branches/${BRANCH_ID}/release-stock`);
        });

        it("retries core 5xx responses and succeeds once core recovers", async () => {
            // Arrange
            app.core.failNext("GET", branchPath, 503, 2);

            // Act
            const branch = await getBranch(BRANCH_ID);

            // Assert
            expect(branch.id).toBe(BRANCH_ID);
            expect(app.core.callsTo("GET", branchPath)).toHaveLength(3);
        });

        it("surfaces a persistent core outage as 503 after three attempts", async () => {
            // Arrange
            app.core.failNext("GET", branchPath, 500, 3);

            // Act
            const act = getBranch(BRANCH_ID);

            // Assert
            await expect(act).rejects.toMatchObject({statusCode: 503, message: "core-service 500"});
            expect(app.core.callsTo("GET", branchPath)).toHaveLength(3);
        });

        it("does not retry core 4xx responses", async () => {
            // Arrange
            const unknownBranch = 999;

            // Act
            const act = getBranch(unknownBranch);

            // Assert
            await expect(act).rejects.toMatchObject({statusCode: 404, message: 'core-service 404: {"error":"BranchNotFound"}'});
            expect(app.core.calls).toHaveLength(1);
        });

        it("loads customer addresses and role permissions", async () => {
            // Arrange — defaults from the core stand-in

            // Act
            const address = await getCustomerAddress(ADDRESS_ID);
            const ownerPerms = await getPermissionsByRole("owner");
            const unknownPerms = await getPermissionsByRole("intern");

            // Assert
            expect(address).toMatchObject({id: ADDRESS_ID, userId: 1, city: "Cairo"});
            expect(ownerPerms).toContain("finance:read");
            expect(unknownPerms).toEqual([]);
        });
    });

    describe("PermissionCacheService", () => {
        it("caches permissions per role and refetches after invalidation", async () => {
            // Arrange
            const permissions = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);
            await permissions.getPermissions("owner");
            await permissions.getPermissions("owner");
            await permissions.getPermissions("staff");

            // Act
            permissions.invalidate("owner");
            await permissions.getPermissions("owner");
            await permissions.handlePermissionsChanged(undefined); // clears every role
            await permissions.getPermissions("staff");

            // Assert
            expect(app.core.callsTo("GET", "/api/internal/rbac/permissions").map((c) => c.path)).toEqual([
                "/api/internal/rbac/permissions?role=owner",
                "/api/internal/rbac/permissions?role=staff",
                "/api/internal/rbac/permissions?role=owner",
                "/api/internal/rbac/permissions?role=staff",
            ]);
        });

        it("checks resource:action grants", () => {
            // Arrange
            const permissions = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);
            const granted = ["orders:read", "finance:read"];

            // Act
            const results = [
                permissions.hasPermission(granted, "orders", "read"),
                permissions.hasPermission(granted, "orders", "cancel"),
            ];

            // Assert
            expect(results).toEqual([true, false]);
        });
    });
});
