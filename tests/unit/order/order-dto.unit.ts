import {
    OrderDetailResponseDTO,
    OrderResponseDTO,
    OrderStatusResponseDTO,
    OrderSummaryResponseDTO,
} from "../../../src/app/order/dto/order.response.dto";
import {OrderStatus, PaymentMethod} from "../../../src/app/order/enums";
import {buildOrderEntity, buildOrderItemEntity, PLACED_AT} from "../../helpers/entities";

const at = (iso: string) => new Date(iso);

describe("OrderResponseDTO", () => {
    it("exposes the public id, money in minor units and items — never the internal ids", () => {
        // Arrange
        const order = buildOrderEntity();
        const items = [buildOrderItemEntity(), buildOrderItemEntity({id: 2, productId: 502, nameSnapshot: "Mint tea", quantity: 1, unitPriceSnapshot: 1000, lineTotal: 1000})];

        // Act
        const dto = OrderResponseDTO.from(order, items);

        // Assert
        expect(dto).toEqual({
            publicId: order.publicId,
            status: "placed",
            paymentMethod: "cod",
            branch: {id: 20},
            restaurant: {id: 10},
            customerAddress: {lat: 30.0444, lng: 31.2357, addressText: "12 Tahrir St, Cairo"},
            subtotal: 15000,
            deliveryFee: 2000,
            serviceFee: 1000,
            total: 18000,
            currency: "EGP",
            items: [
                {productId: 501, name: "Koshary (large)", imageUrl: null, quantity: 2, unitPrice: 7500, lineTotal: 15000},
                {productId: 502, name: "Mint tea", imageUrl: null, quantity: 1, unitPrice: 1000, lineTotal: 1000},
            ],
            createdAt: PLACED_AT.toISOString(),
        });
    });

    it("attaches the payment session for online orders", () => {
        // Arrange
        const order = buildOrderEntity({status: OrderStatus.PENDING_PAYMENT, paymentMethod: PaymentMethod.ONLINE});
        const payment = {sessionId: "9", providerSessionId: "ks_1", redirectUrl: "https://checkout.test/ks_1", expiresAt: "2026-05-10T12:15:00.000Z"};

        // Act
        const dto = OrderResponseDTO.from(order, [], payment);

        // Assert
        expect(dto.payment).toEqual(payment);
        expect(dto.items).toEqual([]);
    });
});

describe("OrderDetailResponseDTO history", () => {
    it("lists every stamped step of a delivered online order in lifecycle order", () => {
        // Arrange
        const order = buildOrderEntity({
            paymentMethod: PaymentMethod.ONLINE,
            status: OrderStatus.DELIVERED,
            acceptedAt: at("2026-05-10T12:01:00.000Z"),
            readyAt: at("2026-05-10T12:20:00.000Z"),
            assignedAt: at("2026-05-10T12:21:00.000Z"),
            pickedAt: at("2026-05-10T12:30:00.000Z"),
            deliveredAt: at("2026-05-10T12:55:00.000Z"),
        });

        // Act
        const dto = OrderDetailResponseDTO.from(order, [buildOrderItemEntity()]);

        // Assert
        expect(dto.history.map((h) => h.status)).toEqual([
            "pending_payment", "placed", "accepted", "ready", "assigned", "picked", "delivered",
        ]);
        expect(dto.history[6]).toEqual({status: "delivered", ts: "2026-05-10T12:55:00.000Z"});
        expect(dto.items).toHaveLength(1);
    });

    it("shows placed then the terminal step for a COD order that died early", () => {
        // Arrange
        const order = buildOrderEntity({status: OrderStatus.REJECTED, rejectedAt: at("2026-05-10T12:02:00.000Z")});

        // Act
        const dto = OrderDetailResponseDTO.from(order, []);

        // Assert
        expect(dto.history).toEqual([
            {status: "placed", ts: PLACED_AT.toISOString()},
            {status: "rejected", ts: "2026-05-10T12:02:00.000Z"},
        ]);
    });
});

describe("OrderSummaryResponseDTO / OrderStatusResponseDTO", () => {
    it("summarises an order for list views with its item count", () => {
        // Arrange
        const order = buildOrderEntity();

        // Act
        const dto = OrderSummaryResponseDTO.from(order, 3);

        // Assert
        expect(dto).toEqual({
            publicId: order.publicId,
            status: "placed",
            total: 18000,
            currency: "EGP",
            itemsCount: 3,
            restaurant: {id: 10},
            branchId: 20,
            createdAt: PLACED_AT.toISOString(),
        });
    });

    it("carries just the status and when it changed for live updates", () => {
        // Arrange
        const order = buildOrderEntity({status: OrderStatus.ACCEPTED, updatedAt: at("2026-05-10T12:01:00.000Z")});

        // Act
        const dto = OrderStatusResponseDTO.from(order);

        // Assert
        expect(dto).toEqual({publicId: order.publicId, status: "accepted", updatedAt: "2026-05-10T12:01:00.000Z"});
    });
});
