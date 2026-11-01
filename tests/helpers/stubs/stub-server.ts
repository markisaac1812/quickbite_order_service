import express, {Express} from "express";
import http from "http";
import type {AddressInfo} from "net";
import {StubCall, StubFailure} from "../types";

/**
 * Minimal stand-in for an external HTTP service (core-service, Kashier).
 * The service's real client code talks to it over real HTTP; the stub only
 * records requests and can be told to fail a route N times to drive the
 * client's retry / error paths.
 */
export abstract class StubServer {
    calls: StubCall[] = [];
    private failures = new Map<string, StubFailure>();
    private server?: http.Server;

    /** Register the service's endpoints. */
    protected abstract routes(app: Express): void;

    /** Restore default data and forget recorded calls / queued failures. */
    abstract reset(): void;

    /** Listen on `port` (0 = ephemeral). Resolves with the bound port. */
    async start(port: number): Promise<number> {
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            this.calls.push({method: req.method, path: req.originalUrl, body: req.body, headers: req.headers});
            const failure = this.failures.get(`${req.method} ${req.path}`);
            if (failure && failure.remaining > 0) {
                failure.remaining -= 1;
                return res.status(failure.status).json(failure.body);
            }
            next();
        });
        this.routes(app);

        this.server = http.createServer(app);
        await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
        return (this.server.address() as AddressInfo).port;
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = undefined;
    }

    /** Make the next `times` requests to `METHOD path` answer `status`. */
    failNext(method: string, path: string, status: number, times = 1, body: unknown = {error: "stubbed failure"}): void {
        this.failures.set(`${method} ${path}`, {status, body, remaining: times});
    }

    /** Recorded calls whose path starts with `pathPrefix`. */
    callsTo(method: string, pathPrefix: string): StubCall[] {
        return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix));
    }

    protected clearRecorded(): void {
        this.calls = [];
        this.failures.clear();
    }
}
