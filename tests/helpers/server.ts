import "reflect-metadata";
import http from "http";
import type {AddressInfo} from "net";
import type {RedisAdapter} from "@socket.io/redis-adapter";
import {createApp} from "../../src/app";
import {attachWsServer} from "../../src/lib/websocket/ws-server";
import {container} from "../../src/lib/di/container";
import {TOKENS} from "../../src/lib/di/tokens";
import {env} from "../../src/lib/config/env";
import {redisClient} from "../../src/lib/cache/init";
import {destroyAll} from "../../src/lib/knex/knex";
import {PermissionCacheService} from "../../src/lib/rbac/permission-cache.service";
import {CoreStub} from "./stubs/core-stub";
import {KashierStub} from "./stubs/kashier-stub";
import {truncateAll} from "./db";
import {flushTestRedis} from "./redis";
import {TestServer} from "./types";

/**
 * Boots the service the way server.ts does — express app and socket.io on one
 * http server, io registered in DI — so services that broadcast after a commit
 * run their real code path. Also starts the core-service and Kashier
 * stand-ins on the ports .env.test points the real clients at.
 */
export async function startTestServer(): Promise<TestServer> {
    const core = new CoreStub();
    const kashier = new KashierStub();
    core.reset();
    kashier.reset();

    let server: http.Server;
    let io: ReturnType<typeof attachWsServer>;
    try {
        await core.start(Number(new URL(env.core.baseUrl).port));
        await kashier.start(Number(new URL(env.kashier.baseUrl).port));
        server = http.createServer(createApp());
        io = attachWsServer(server);
        container.registerInstance(TOKENS.WsServer, io);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    } catch (err) {
        // Don't leave the fixed stub ports bound for the next test file.
        await core.stop();
        await kashier.stop();
        throw err;
    }
    const {port} = server.address() as AddressInfo;

    return {
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        core,
        kashier,
        async reset() {
            for (const region of env.regions) {
                await truncateAll(region, "hot");
                await truncateAll(region, "archive");
            }
            await flushTestRedis();
            core.reset();
            kashier.reset();
            container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService).invalidate();
        },
        async stop() {
            const adapter = io.of("/").adapter as unknown as RedisAdapter;
            await io.close(); // also closes the http server
            await adapter.subClient.quit();
            await redisClient.quit();
            await destroyAll();
            await core.stop();
            await kashier.stop();
        },
    };
}
