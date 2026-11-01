import {cacheProvider, redisClient} from "../../../src/lib/cache/init";
import {flushTestRedis} from "../../helpers/redis";

describe("RedisCacheProvider (real Redis, test DB)", () => {
    afterAll(async () => {
        await redisClient.quit();
    });

    beforeEach(async () => {
        await flushTestRedis();
    });

    it("sets, reads and deletes string values, with and without a TTL", async () => {
        // Arrange
        await cacheProvider.set("plain", "v1");
        await cacheProvider.set("expiring", "v2", 60);

        // Act
        const values = [await cacheProvider.get("plain"), await cacheProvider.get("expiring"), await cacheProvider.get("missing")];
        const ttls = [await cacheProvider.ttl("plain"), await cacheProvider.ttl("expiring"), await cacheProvider.ttl("missing")];
        const deleted = [await cacheProvider.del("plain"), await cacheProvider.del("plain")];

        // Assert
        expect(values).toEqual(["v1", "v2", null]);
        expect(ttls[0]).toBe(-1);
        expect(ttls[1]).toBeGreaterThan(55);
        expect(ttls[2]).toBe(-2);
        expect(deleted).toEqual([1, 0]);
    });

    it("trySet only writes when the key is absent (locks, dedupe)", async () => {
        // Arrange
        const first = await cacheProvider.trySet("lock", "owner-a", 30);

        // Act
        const second = await cacheProvider.trySet("lock", "owner-b", 30);
        const noTtl = await cacheProvider.trySet("forever", "x");

        // Assert
        expect([first, second, noTtl]).toEqual([true, false, true]);
        expect(await cacheProvider.get("lock")).toBe("owner-a");
        expect(await cacheProvider.ttl("forever")).toBe(-1);
    });

    it("counts with incr, checks existence and sets expiry", async () => {
        // Arrange
        await cacheProvider.incr("attempts");

        // Act
        const second = await cacheProvider.incr("attempts");
        await cacheProvider.expire("attempts", 120);

        // Assert
        expect(second).toBe(2);
        expect(await cacheProvider.exists("attempts")).toBe(true);
        expect(await cacheProvider.exists("nope")).toBe(false);
        expect(await cacheProvider.ttl("attempts")).toBeGreaterThan(110);
    });

    it("writes a hash and its TTL atomically", async () => {
        // Arrange
        const fields = {lat: "30.05", lng: "31.24"};

        // Act
        await cacheProvider.hsetWithTtl("presence", fields, 300);
        await cacheProvider.hsetWithTtl("no-ttl", fields);

        // Assert
        expect(await redisClient.hgetall("presence")).toEqual(fields);
        expect(await cacheProvider.ttl("presence")).toBeGreaterThan(290);
        expect(await cacheProvider.ttl("no-ttl")).toBe(-1);
    });

    it("adds, checks and removes set members", async () => {
        // Arrange
        await cacheProvider.sadd("busy", "300");

        // Act
        const before = await cacheProvider.sismember("busy", "300");
        await cacheProvider.srem("busy", "300");
        const after = await cacheProvider.sismember("busy", "300");

        // Assert
        expect([before, after]).toEqual([true, false]);
    });

    it("finds geo members nearest-first within a radius, capped by count", async () => {
        // Arrange — around (31.24, 30.05)
        await cacheProvider.geoadd("geo", 31.241, 30.051, "near");
        await cacheProvider.geoadd("geo", 31.25, 30.06, "mid");
        await cacheProvider.geoadd("geo", 31.24, 30.3, "far");

        // Act
        const within5km = await cacheProvider.geosearchByRadius("geo", 31.24, 30.05, 5000, 10);
        const nearestOne = await cacheProvider.geosearchByRadius("geo", 31.24, 30.05, 5000, 1);
        await cacheProvider.zrem("geo", "near");
        const afterRemove = await cacheProvider.geosearchByRadius("geo", 31.24, 30.05, 5000, 10);

        // Assert
        expect(within5km).toEqual(["near", "mid"]);
        expect(nearestOne).toEqual(["near"]);
        expect(afterRemove).toEqual(["mid"]);
    });
});
