import {io as ioClient, Socket} from "socket.io-client";
import {JWTPayload} from "../../src/lib/auth/jwt";
import {signAccessToken} from "./auth";

/** Connects as `user` and resolves once the server has authenticated the socket. */
export async function connectAs(baseUrl: string, user: JWTPayload): Promise<Socket> {
    const socket = ioClient(baseUrl, {
        path: "/ws",
        auth: {token: signAccessToken(user)},
        transports: ["websocket"],
        reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
        socket.once("hello", () => resolve());
        socket.once("connect_error", reject);
    });
    return socket;
}

export async function subscribe(socket: Socket, channel: string): Promise<void> {
    const ack = await socket.emitWithAck("subscribe", channel);
    if (!ack?.ok) throw new Error(`subscribe to ${channel} refused: ${JSON.stringify(ack)}`);
}

/** Resolves with the payload of the next `event` (Jest's test timeout bounds the wait). */
export function nextEvent<T = unknown>(socket: Socket, event: string): Promise<T> {
    return new Promise<T>((resolve) => socket.once(event, resolve));
}
