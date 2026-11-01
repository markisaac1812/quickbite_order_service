import {PaymentInitResponseDTO, PaymentResponseDTO} from "../../../src/app/payment/dto/payment.response.dto";
import {TransactionMethod, TransactionType} from "../../../src/app/payment/enums";
import {buildPaymentSessionEntity, buildTransactionEntity, PLACED_AT} from "../../helpers/entities";

describe("PaymentResponseDTO", () => {
    it("maps a Kashier charge and names the provider", () => {
        // Arrange
        const tx = buildTransactionEntity();

        // Act
        const dto = PaymentResponseDTO.from(tx);

        // Assert
        expect(dto).toEqual({
            id: 55,
            orderId: 7,
            type: "charge",
            method: "online",
            provider: "kashier",
            providerReferenceId: "TX-1001",
            status: "succeeded",
            amount: 18000,
            currency: "EGP",
            isRefunded: false,
            refundedPaymentId: null,
            createdAt: PLACED_AT.toISOString(),
            updatedAt: PLACED_AT.toISOString(),
        });
    });

    it("has no provider for provider-less ledger rows and unknown provider ids", () => {
        // Arrange
        const codCollection = buildTransactionEntity({transactionType: TransactionType.COD_COLLECTION, method: TransactionMethod.COD, providerId: null});
        const unknownProvider = buildTransactionEntity({providerId: 99});

        // Act
        const dtos = [PaymentResponseDTO.from(codCollection), PaymentResponseDTO.from(unknownProvider)];

        // Assert
        expect(dtos.map((d) => d.provider)).toEqual([null, null]);
    });
});

describe("PaymentInitResponseDTO", () => {
    it("returns the redirect the customer needs and stringifies our session id", () => {
        // Arrange
        const session = buildPaymentSessionEntity();

        // Act
        const dto = PaymentInitResponseDTO.from(session, "2026-05-10T12:15:00.000Z");

        // Assert
        expect(dto).toEqual({
            sessionId: "9",
            providerSessionId: "ks_session_1",
            redirectUrl: "https://checkout.kashier.test/ks_session_1",
            amount: 18000,
            currency: "EGP",
            expiresAt: "2026-05-10T12:15:00.000Z",
        });
    });
});
