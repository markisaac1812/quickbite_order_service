import {PayoutResponseDTO, RestaurantBalanceResponseDTO} from "../../../src/app/finance/dto/finance.response.dto";
import {TransactionMethod, TransactionType} from "../../../src/app/payment/enums";
import {buildBalanceEntity, buildTransactionEntity, PLACED_AT} from "../../helpers/entities";

describe("RestaurantBalanceResponseDTO", () => {
    it("lists one balance per currency, stamped with the read time", () => {
        // Arrange
        const rows = [buildBalanceEntity(), buildBalanceEntity({currency: "SAR", balance: 900})];
        const before = Date.now();

        // Act
        const dto = RestaurantBalanceResponseDTO.from(10, rows);

        // Assert
        expect(dto.restaurantId).toBe(10);
        expect(dto.balances).toEqual([{currency: "EGP", balance: 13500}, {currency: "SAR", balance: 900}]);
        expect(new Date(dto.asOf).getTime()).toBeGreaterThanOrEqual(before);
    });
});

describe("PayoutResponseDTO", () => {
    it("exposes the payout without its ledger account ids", () => {
        // Arrange
        const payout = buildTransactionEntity({
            id: 77,
            orderId: null,
            transactionType: TransactionType.PAYOUT,
            method: TransactionMethod.BANK_TRANSFER,
            providerId: null,
            providerReferenceId: "BANK-REF-1",
            amount: 10000,
        });

        // Act
        const dto = PayoutResponseDTO.from(payout);

        // Assert
        expect(dto).toEqual({
            id: 77,
            amount: 10000,
            currency: "EGP",
            status: "succeeded",
            providerReferenceId: "BANK-REF-1",
            createdAt: PLACED_AT.toISOString(),
        });
    });
});
