import {KashierClient} from "../../../src/pkg/payments/kashier/kashier.client";
import {computeWebhookSignature} from "../../../src/pkg/payments/kashier/kashier.signature";
import {KashierStub} from "../../helpers/stubs/kashier-stub";

const SESSIONS_PATH = "/v3/payment/sessions";
const SESSION_TIMEOUT_SEC = 900;

describe("KashierClient (pkg) against a Kashier stand-in", () => {
    const stub = new KashierStub();
    let client: KashierClient;

    const sessionInput = {
        merchantOrderId: "5f1e9a7c-2b3d-4c8e-9f10-123456789abc",
        amount: "180.00",
        currency: "EGP",
        description: "QuickBite order",
        customerReference: "1",
    };

    beforeAll(async () => {
        const port = await stub.start(0);
        client = new KashierClient({
            baseUrl: `http://127.0.0.1:${port}`,
            merchantId: "MID-PKG",
            apiKey: "pkg-api-key",
            secretKey: "pkg-secret-key",
            paymentType: "credit",
            serverWebhookUrl: "https://hooks.test/kashier",
            merchantRedirect: "https://shop.test/return",
            sessionTimeoutSec: SESSION_TIMEOUT_SEC,
        });
    });

    afterAll(async () => {
        await stub.stop();
    });

    beforeEach(() => {
        stub.reset();
    });

    it("creates a one-time 3DS session and maps Kashier's response", async () => {
        // Arrange — defaults

        // Act
        const result = await client.createSession(sessionInput);

        // Assert
        expect(result).toEqual({
            providerSessionId: "ks_session_1",
            redirectUrl: "https://checkout.kashier.test/ks_session_1",
            rawResponse: expect.objectContaining({_id: "ks_session_1", status: "CREATED"}),
            expiresAt: expect.stringMatching(/Z$/),
        });
        const [call] = stub.calls;
        expect(call.body).toMatchObject({
            merchantId: "MID-PKG",
            paymentType: "credit",
            amount: "180.00",
            order: sessionInput.merchantOrderId,
            type: "one-time",
            allowedMethods: "card,wallet",
            enable3DS: true,
            serverWebhook: "https://hooks.test/kashier",
            merchantRedirect: "https://shop.test/return",
            failureRedirect: false,
            interactionSource: "ECOMMERCE",
            customer: {reference: "1"},
        });
        expect(call.headers["api-key"]).toBe("pkg-api-key");
        expect(call.headers.authorization).toBe("pkg-secret-key");
    });

    it("retries Kashier 5xx responses and succeeds once Kashier recovers", async () => {
        // Arrange
        stub.failNext("POST", SESSIONS_PATH, 502, 2);

        // Act
        const result = await client.createSession(sessionInput);

        // Assert
        expect(result.providerSessionId).toBe("ks_session_1");
        expect(stub.calls).toHaveLength(3);
    });

    it("gives up after three 5xx attempts", async () => {
        // Arrange
        stub.failNext("POST", SESSIONS_PATH, 500, 3);

        // Act
        const act = client.createSession(sessionInput);

        // Assert
        await expect(act).rejects.toThrow('kashier 500: {"error":"stubbed failure"}');
        expect(stub.calls).toHaveLength(3);
    });

    it("does not retry a 4xx and surfaces its status", async () => {
        // Arrange
        stub.failNext("POST", SESSIONS_PATH, 422, 1, {message: "amount must be positive"});

        // Act
        const act = client.createSession(sessionInput);

        // Assert
        await expect(act).rejects.toMatchObject({message: 'kashier 422: {"message":"amount must be positive"}', statusCode: 422});
        expect(stub.calls).toHaveLength(1);
    });

    it("rejects a response without a session id or URL", async () => {
        // Arrange
        stub.responseOverride = {status: "CREATED"};

        // Act
        const act = client.createSession(sessionInput);

        // Assert
        await expect(act).rejects.toThrow('kashier: malformed session response: {"status":"CREATED"}');
    });

    it("falls back to its own expiry when Kashier omits expireAt", async () => {
        // Arrange
        stub.responseOverride = {_id: "ks_x", sessionUrl: "https://checkout.kashier.test/ks_x"};
        const before = Date.now();

        // Act
        const result = await client.createSession(sessionInput);

        // Assert
        const expiresAt = new Date(result.expiresAt!).getTime();
        expect(expiresAt).toBeGreaterThanOrEqual(before + SESSION_TIMEOUT_SEC * 1000 - 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TIMEOUT_SEC * 1000);
    });

    it("verifies webhooks with the API key as the HMAC secret", () => {
        // Arrange
        const payload = {transactionId: "TX-1", status: "SUCCESS", amount: 180};
        const signatureKeys = ["amount", "status", "transactionId"];
        const genuine = computeWebhookSignature(payload, signatureKeys, "pkg-api-key");
        const forged = computeWebhookSignature(payload, signatureKeys, "someone-else");

        // Act
        const results = [genuine, forged].map((signature) => client.verifyWebhook({payload, signatureKeys, signature}));

        // Assert
        expect(results).toEqual([true, false]);
    });
});
