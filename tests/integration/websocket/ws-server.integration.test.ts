import "reflect-metadata";
import {io as ioClient, Socket} from "socket.io-client";
import type {Server as IoServer} from "socket.io";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {startTestServer} from "../../helpers/server";
import {connectAs, nextEvent, subscribe} from "../../helpers/ws";
import {CUSTOMER, RESTAURANT_OWNER, signAccessToken} from "../../helpers/auth";
import {TestServer} from "../../helpers/types";

/** Resolves with the connect_error a server middleware raised for this handshake. */
function connectError(baseUrl: string, auth?: {token: string}): Promise<Error> {
    const socket = ioClient(baseUrl, {path: "/ws", auth, transports: ["websocket"], reconnection: false});
    return new Promise((resolve) => {
        socket.once("connect_error", (err) => {
            socket.disconnect();
            resolve(err);
        });
    });
}

describe("WebSocket server (/ws)", () => {
    let app: TestServer;
    let io: IoServer;
    const sockets: Socket[] = [];

    beforeAll(async () => {
        app = await startTestServer();
        io = container.resolve<IoServer>(TOKENS.WsServer);
    });

    afterAll(async () => {
        await app.stop();
    });

    afterEach(() => {
        sockets.splice(0).forEach((s) => s.disconnect());
    });

    it("refuses handshakes without a token or with an invalid one", async () => {
        // Arrange
        const badToken = {token: "not-a-jwt"};

        // Act
        const [missing, invalid] = await Promise.all([connectError(app.baseUrl), connectError(app.baseUrl, badToken)]);

        // Assert
        expect(missing.message).toBe("No token provided");
        expect(invalid.message).toBe("User not authenticated");
    });

    it("greets an authenticated socket with the channels it may join", async () => {
        // Arrange
        const socket = ioClient(app.baseUrl, {path: "/ws", auth: {token: signAccessToken(RESTAURANT_OWNER)}, transports: ["websocket"], reconnection: false});
        sockets.push(socket);

        // Act
        const hello = await nextEvent<{allowedChannels: string[]}>(socket, "hello");

        // Assert
        expect(hello).toEqual({allowedChannels: ["customer:100", "restaurant:10", "branch:20"]});
    });

    it("refuses subscriptions to channels outside the user's scope", async () => {
        // Arrange
        const socket = await connectAs(app.baseUrl, CUSTOMER);
        sockets.push(socket);

        // Act
        const foreign = await socket.emitWithAck("subscribe", "branch:20");
        const notAString = await socket.emitWithAck("subscribe", 42);

        // Assert
        expect(foreign).toEqual({ok: false, error: "not permitted"});
        expect(notAString).toEqual({ok: false, error: "not permitted"});
    });

    it("delivers room broadcasts after subscribe and stops after unsubscribe", async () => {
        // Arrange
        const socket = await connectAs(app.baseUrl, CUSTOMER);
        sockets.push(socket);
        const confirmed = nextEvent(socket, "subscribed");
        await subscribe(socket, "customer:1");
        await expect(confirmed).resolves.toEqual({channel: "customer:1"});
        const received: unknown[] = [];
        socket.on("order.status_changed", (payload) => received.push(payload));

        // Act
        io.to("customer:1").emit("order.status_changed", {n: 1});
        await new Promise((r) => setTimeout(r, 200));
        socket.emit("unsubscribe", "customer:1");
        await new Promise((r) => setTimeout(r, 100));
        io.to("customer:1").emit("order.status_changed", {n: 2});
        await new Promise((r) => setTimeout(r, 200));

        // Assert
        expect(received).toEqual([{n: 1}]);
    });
});
