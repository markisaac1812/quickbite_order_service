import {Express} from "express";
import {StubServer} from "./stub-server";

/**
 * Stand-in for Kashier's Payment Sessions API (POST /v3/payment/sessions).
 * Answers like the real sandbox: `{_id, status, sessionUrl, expireAt}`.
 */
export class KashierStub extends StubServer {
    private sequence = 0;
    /** When set, returned verbatim instead of a well-formed session. */
    responseOverride: Record<string, unknown> | null = null;

    reset(): void {
        this.clearRecorded();
        this.sequence = 0;
        this.responseOverride = null;
    }

    protected routes(app: Express): void {
        app.post("/v3/payment/sessions", (req, res) => {
            if (this.responseOverride) return res.json(this.responseOverride);
            this.sequence += 1;
            const id = `ks_session_${this.sequence}`;
            res.json({
                _id: id,
                status: "CREATED",
                sessionUrl: `https://checkout.kashier.test/${id}`,
                expireAt: req.body.expireAt,
            });
        });
    }
}
