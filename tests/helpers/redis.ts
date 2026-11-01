import {redisClient} from "../../src/lib/cache/init";
import {env} from "../../src/lib/config/env";

/** Wipes the dedicated test Redis DB. Refuses DB 0 (the dev/default DB). */
export async function flushTestRedis(): Promise<void> {
    if (env.redis.db === 0) {
        throw new Error("Refusing to FLUSHDB Redis DB 0 — set REDIS_DB to a dedicated test DB in .env.test");
    }
    await redisClient.flushdb();
}
