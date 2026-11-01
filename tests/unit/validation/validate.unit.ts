import "reflect-metadata"; // decorated DTOs need it, as in server.ts / container.ts
import {validateBody} from "../../../src/lib/validation/validate";
import {CreateOrderRequestDTO, OrderItemInputDTO, UpdateOrderStatusRequestDTO} from "../../../src/app/order/dto/order.request.dto";
import {CreatePayoutRequestDTO} from "../../../src/app/finance/dto/finance.request.dto";
import {PresenceLocationRequestDTO} from "../../../src/app/agent/dto/agent.request.dto";

describe("validateBody", () => {
    it("returns a typed instance with nested items for a valid order", async () => {
        // Arrange
        const body = {branchId: 20, customerAddressId: 30, paymentMethod: "cod", items: [{productId: 501, quantity: 2}]};

        // Act
        const dto = await validateBody(CreateOrderRequestDTO, body);

        // Assert
        expect(dto).toBeInstanceOf(CreateOrderRequestDTO);
        expect(dto.items[0]).toBeInstanceOf(OrderItemInputDTO);
        expect(dto.items[0].quantity).toBe(2);
    });

    it("rejects with 400 and reports nested item errors", async () => {
        // Arrange
        const body = {branchId: 20, customerAddressId: 30, paymentMethod: "cod", items: [{productId: 501, quantity: 0}]};

        // Act
        const act = validateBody(CreateOrderRequestDTO, body);

        // Assert
        await expect(act).rejects.toMatchObject({statusCode: 400, message: "quantity must not be less than 1"});
    });

    it("reports every violated rule at once", async () => {
        // Arrange
        const body = {branchId: 0, customerAddressId: 30, paymentMethod: "bitcoin", items: []};

        // Act
        const act = validateBody(CreateOrderRequestDTO, body);

        // Assert
        await expect(act).rejects.toMatchObject({
            statusCode: 400,
            message: [
                "branchId must not be less than 1",
                "paymentMethod must be one of the following values: online, cod",
                "items must contain at least 1 elements",
            ].join("\n"),
        });
    });

    it("strips properties the DTO does not declare", async () => {
        // Arrange
        const body = {status: "cancelled", reason: "changed my mind", isAdmin: true};

        // Act
        const dto = await validateBody(UpdateOrderStatusRequestDTO, body);

        // Assert
        expect(dto).toEqual({status: "cancelled", reason: "changed my mind"});
    });

    it("validates payout and presence payloads", async () => {
        // Arrange
        const payout = {restaurantId: 10, amount: -5, currency: "EGP", providerReferenceId: "BANK-1"};
        const location = {lat: 120, lng: 31.2};

        // Act
        const payoutAct = validateBody(CreatePayoutRequestDTO, payout);
        const locationAct = validateBody(PresenceLocationRequestDTO, location);

        // Assert
        await expect(payoutAct).rejects.toMatchObject({message: "amount must be a positive number"});
        await expect(locationAct).rejects.toMatchObject({message: "lat must be a latitude string or number"});
    });
});
