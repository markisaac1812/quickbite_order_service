import "reflect-metadata";
import {randomUUID} from "crypto";
import {env} from "../../../src/lib/config/env";
import {redisClient} from "../../../src/lib/cache/init";
import {messageBroker} from "../../../src/lib/messaging/init";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {listRegisteredHandlers, registerHandler, startCoreEventsConsumer} from "../../../src/lib/core-events/consumer";
import {registerOrderModuleCoreEventHandlers} from "../../../src/app/order/core-events.handlers";
import {CoreDataCacheService} from "../../../src/app/order/service/core-data-cache.service";
import {PermissionCacheService} from "../../../src/lib/rbac/permission-cache.service";
import {startTestServer} from "../../helpers/server";
import {AmqpProbe} from "../../helpers/amqp";
import {waitFor} from "../../helpers/wait";
import {BRANCH_ID, branchFixture, productsFixture, RESTAURANT_ID} from "../../helpers/fixtures";
import {TestServer} from "../../helpers/types";

const productKey = (productId: number) => `core:branch:${BRANCH_ID}:product:${productId}`;
const rejectFlagKey = `branch:reject-new-orders:${BRANCH_ID}`;

/** Publishes a core-service event envelope onto the (test) core.events exchange. */
function publishCoreEvent(eventType: string, payload: unknown, eventId: string = randomUUID()) {
    const envelope = {eventId, eventType, occurredAt: new Date().toISOString(), payload};
    return messageBroker.publish(env.rabbit.exchange, eventType, Buffer.from(JSON.stringify(envelope)));
}

const cachedJson = async (key: string) => {
    const raw = await redisClient.get(key);
    return raw === null ? null : JSON.parse(raw);
};

describe("core-events consumer (real RabbitMQ)", () => {
    let app: TestServer;
    let probe: AmqpProbe;

    beforeAll(async () => {
        app = await startTestServer();
        probe = await AmqpProbe.open();
        await probe.purge(env.rabbit.queue); // leftovers from an aborted earlier run
        registerOrderModuleCoreEventHandlers();
        await startCoreEventsConsumer(messageBroker);
    });

    afterAll(async () => {
        // Always release the app (fixed stub ports) even if broker teardown fails.
        await messageBroker.close().catch(() => {});
        await probe?.close().catch(() => {});
        await app?.stop();
    });

    beforeEach(async () => {
        await app.reset();
        await probe.purge(env.rabbit.dlq);
    });

    it("registers one handler per consumed event type and refuses duplicates", () => {
        // Arrange
        const duplicate = async () => {};

        // Act
        const registered = listRegisteredHandlers();
        const act = () => registerHandler("branch.updated", duplicate);

        // Assert
        expect(registered.sort()).toEqual([
            "branch.deactivated",
            "branch.updated",
            "product.price.changed",
            "product.stock.changed",
            "rbac.permissions_changed",
            "restaurant.suspended",
        ]);
        expect(act).toThrow("Handler already registered for branch.updated");
    });

    it("merges a stock change into the cached product without losing its other fields", async () => {
        // Arrange
        const koshary = productsFixture()[0];
        await redisClient.set(productKey(501), JSON.stringify(koshary));

        // Act
        await publishCoreEvent("product.stock.changed", {branchId: BRANCH_ID, productId: 501, newStock: 3, isAvailable: false});

        // Assert
        await waitFor(async () => (await cachedJson(productKey(501)))?.stock === 3);
        expect(await cachedJson(productKey(501))).toEqual({...koshary, stock: 3, isAvailable: false});
    });

    it("stores a price change as a partial entry for a product that is not cached yet", async () => {
        // Arrange — nothing cached for product 502

        // Act
        await publishCoreEvent("product.price.changed", {branchId: BRANCH_ID, productId: 502, newPrice: 1250});

        // Assert
        await waitFor(async () => (await cachedJson(productKey(502))) !== null);
        expect(await cachedJson(productKey(502))).toEqual({price: 1250, productId: 502});
    });

    it("flags a deactivated branch so new orders are refused, and clears the flag on update", async () => {
        // Arrange
        const coreData = container.resolve<CoreDataCacheService>(TOKENS.CoreDataCacheService);
        await redisClient.set(`core:branch:${BRANCH_ID}`, JSON.stringify(branchFixture()));

        // Act
        await publishCoreEvent("branch.deactivated", {branchId: BRANCH_ID});
        await waitFor(() => coreData.isBranchRejectingOrders(BRANCH_ID));
        const branchCachedAfterDeactivate = await redisClient.exists(`core:branch:${BRANCH_ID}`);
        await publishCoreEvent("branch.updated", {branchId: BRANCH_ID});

        // Assert
        expect(branchCachedAfterDeactivate).toBe(0);
        await waitFor(async () => !(await coreData.isBranchRejectingOrders(BRANCH_ID)));
        expect(await redisClient.exists(rejectFlagKey)).toBe(0);
    });

    it("drops the cached restaurant when core suspends it", async () => {
        // Arrange
        await redisClient.set(`core:restaurant:${RESTAURANT_ID}`, JSON.stringify({id: RESTAURANT_ID, status: "active"}));

        // Act
        await publishCoreEvent("restaurant.suspended", {restaurantId: RESTAURANT_ID});

        // Assert
        await waitFor(async () => (await redisClient.exists(`core:restaurant:${RESTAURANT_ID}`)) === 0);
    });

    it("invalidates the in-process permission cache on rbac.permissions_changed", async () => {
        // Arrange
        const permissions = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);
        await permissions.getPermissions("staff");
        const rbacCalls = () => app.core.callsTo("GET", "/api/internal/rbac/permissions").length;
        app.core.permissions.set("staff", ["orders:read", "orders:cancel"]);

        // Act
        await publishCoreEvent("rbac.permissions_changed", {role: "staff"});

        // Assert — the next read goes back to core and sees the new grant
        await waitFor(async () => {
            await permissions.getPermissions("staff");
            return rbacCalls() >= 2;
        });
        expect(await permissions.getPermissions("staff")).toEqual(["orders:read", "orders:cancel"]);
    });

    it("processes a redelivered event only once", async () => {
        // Arrange
        await redisClient.set(productKey(501), JSON.stringify(productsFixture()[0]));
        const eventId = randomUUID();
        await publishCoreEvent("product.stock.changed", {branchId: BRANCH_ID, productId: 501, newStock: 5}, eventId);
        await waitFor(async () => (await cachedJson(productKey(501)))?.stock === 5);

        // Act — same eventId again (broker redelivery), then an unrelated sentinel event
        await publishCoreEvent("product.stock.changed", {branchId: BRANCH_ID, productId: 501, newStock: 9}, eventId);
        await publishCoreEvent("product.price.changed", {branchId: BRANCH_ID, productId: 502, newPrice: 1});

        // Assert
        await waitFor(async () => (await cachedJson(productKey(502))) !== null);
        expect((await cachedJson(productKey(501))).stock).toBe(5);
    });

    it("dead-letters unparseable messages and events whose handler fails", async () => {
        // Arrange — a corrupt cache entry makes the stock handler throw
        await redisClient.set(productKey(501), "{corrupt");

        // Act
        await messageBroker.publish(env.rabbit.exchange, "product.stock.changed", Buffer.from("not json"));
        await messageBroker.publish(env.rabbit.exchange, "product.stock.changed", Buffer.from(JSON.stringify({eventId: "e-1", payload: {}}))); // no eventType
        await publishCoreEvent("product.stock.changed", {branchId: BRANCH_ID, productId: 501, newStock: 1});

        // Assert
        await waitFor(async () => (await probe.messageCount(env.rabbit.dlq)) === 3);
    });

    it("acknowledges event types it has no handler for", async () => {
        // Arrange — product.archived matches the product.# binding but nobody handles it

        // Act
        await publishCoreEvent("product.archived", {branchId: BRANCH_ID, productId: 501});
        await publishCoreEvent("product.price.changed", {branchId: BRANCH_ID, productId: 502, newPrice: 1}); // sentinel

        // Assert
        await waitFor(async () => (await cachedJson(productKey(502))) !== null);
        expect(await probe.messageCount(env.rabbit.dlq)).toBe(0);
        expect(await probe.messageCount(env.rabbit.queue)).toBe(0);
    });

    it("ignores payloads that are missing their ids", async () => {
        // Arrange
        const coreData = container.resolve<CoreDataCacheService>(TOKENS.CoreDataCacheService);

        // Act — handlers are called directly with incomplete payloads
        await coreData.handleProductStockChanged({branchId: BRANCH_ID});
        await coreData.handleProductPriceChanged({productId: 501});
        await coreData.handleBranchUpdated({});
        await coreData.handleBranchDeactivated(undefined);
        await coreData.handleRestaurantSuspended({});

        // Assert
        expect(await redisClient.dbsize()).toBe(0);
    });
});
