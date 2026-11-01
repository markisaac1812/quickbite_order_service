import {createHmac} from "crypto";
import {
    buildSignaturePayload,
    computeWebhookSignature,
    verifyWebhookSignature,
} from "../../../src/pkg/payments/kashier/kashier.signature";

const API_KEY = "unit-test-kashier-api-key";

// Shape of a real Kashier `pay` webhook `data` object (trimmed).
function webhookData(): Record<string, unknown> {
    return {
        merchantOrderId: "5f1e9a7c-2b3d-4c8e-9f10-123456789abc",
        transactionId: "TX-1001",
        orderReference: "TEST-ORD 42|A",
        status: "SUCCESS",
        amount: 184.5,
        currency: "EGP",
        method: "card", // present on the payload but NOT signed
    };
}

const SIGNATURE_KEYS = ["transactionId", "status", "orderReference", "merchantOrderId", "currency", "amount"];

describe("Kashier webhook signature", () => {
    it("builds the canonical payload from signed keys only, sorted and URL-encoded", () => {
        // Arrange
        const data = webhookData();

        // Act
        const payload = buildSignaturePayload(data, SIGNATURE_KEYS);

        // Assert
        expect(payload).toBe(
            "amount=184.5" +
            "&currency=EGP" +
            "&merchantOrderId=5f1e9a7c-2b3d-4c8e-9f10-123456789abc" +
            "&orderReference=TEST-ORD%2042%7CA" +
            "&status=SUCCESS" +
            "&transactionId=TX-1001",
        );
    });

    it("signs the canonical payload with HMAC-SHA256 (hex) keyed by the API key", () => {
        // Arrange
        const canonical = buildSignaturePayload(webhookData(), SIGNATURE_KEYS);
        const expected = createHmac("sha256", API_KEY).update(canonical, "utf8").digest("hex");

        // Act
        const signature = computeWebhookSignature(webhookData(), SIGNATURE_KEYS, API_KEY);

        // Assert
        expect(signature).toBe(expected);
    });

    it("accepts a signature Kashier produced over the same data", () => {
        // Arrange
        const signature = computeWebhookSignature(webhookData(), SIGNATURE_KEYS, API_KEY);

        // Act
        const ok = verifyWebhookSignature(webhookData(), SIGNATURE_KEYS, API_KEY, signature);

        // Assert
        expect(ok).toBe(true);
    });

    it("rejects the signature when a signed field was tampered with", () => {
        // Arrange
        const signature = computeWebhookSignature(webhookData(), SIGNATURE_KEYS, API_KEY);
        const tampered = {...webhookData(), amount: 1.5};

        // Act
        const ok = verifyWebhookSignature(tampered, SIGNATURE_KEYS, API_KEY, signature);

        // Assert
        expect(ok).toBe(false);
    });

    it("rejects a signature produced with a different key", () => {
        // Arrange
        const forged = computeWebhookSignature(webhookData(), SIGNATURE_KEYS, "attacker-key");

        // Act
        const ok = verifyWebhookSignature(webhookData(), SIGNATURE_KEYS, API_KEY, forged);

        // Assert
        expect(ok).toBe(false);
    });

    it("returns false (never throws) for empty, truncated or non-hex signatures", () => {
        // Arrange
        const valid = computeWebhookSignature(webhookData(), SIGNATURE_KEYS, API_KEY);
        const malformed = ["", valid.slice(0, 10), "z".repeat(valid.length)];

        // Act
        const results = malformed.map((sig) => verifyWebhookSignature(webhookData(), SIGNATURE_KEYS, API_KEY, sig));

        // Assert
        expect(results).toEqual([false, false, false]);
    });
});
