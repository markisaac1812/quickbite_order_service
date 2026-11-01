import {OrderEntity} from "../../src/app/order/entity/order.entity";
import {OrderItemEntity} from "../../src/app/order/entity/order-item.entity";
import {OrderStatus, PaymentMethod, Currency} from "../../src/app/order/enums";
import {TransactionEntity} from "../../src/app/payment/entity/transaction.entity";
import {PaymentSessionEntity} from "../../src/app/payment/entity/payment-session.entity";
import {TransactionType, TransactionMethod, TransactionStatus, PaymentSessionStatus} from "../../src/app/payment/enums";
import {AgentEarningEntity} from "../../src/app/agent/entity/agent-earning.entity";
import {RestaurantBalanceEntity} from "../../src/app/finance/entity/restaurant-balance.entity";

// In-memory entities for unit tests of pure mappers (response DTOs). Same
// defaults as the DB factories so the numbers read the same everywhere.

export const PLACED_AT = new Date("2026-05-10T12:00:00.000Z");

export function buildOrderEntity(overrides: Partial<OrderEntity> = {}): OrderEntity {
    return new OrderEntity({
        id: 7,
        region: "eg",
        publicId: "0b6f6f5e-6f1f-4f44-9d43-6d1b0f3f1a11",
        countryCode: "EG",
        restaurantId: 10,
        restaurantOwnerId: 100,
        branchId: 20,
        customerId: 1,
        customerAddressId: 30,
        deliveryLat: 30.0444,
        deliveryLng: 31.2357,
        deliveryAddressTextSnapshot: "12 Tahrir St, Cairo",
        branchLat: 30.05,
        branchLng: 31.24,
        status: OrderStatus.PLACED,
        subtotal: 15000,
        deliveryFee: 2000,
        serviceFee: 1000,
        total: 18000,
        commission: 0,
        currency: Currency.EGP,
        paymentMethod: PaymentMethod.COD,
        deliveryAgentId: null,
        createdAt: PLACED_AT,
        updatedAt: PLACED_AT,
        acceptedAt: null,
        rejectedAt: null,
        readyAt: null,
        assignedAt: null,
        pickedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        ...overrides,
    });
}

export function buildOrderItemEntity(overrides: Partial<OrderItemEntity> = {}): OrderItemEntity {
    return new OrderItemEntity({
        id: 1,
        region: "eg",
        orderId: 7,
        productId: 501,
        quantity: 2,
        unitPriceSnapshot: 7500,
        nameSnapshot: "Koshary (large)",
        imageUrlSnapshot: null,
        lineTotal: 15000,
        createdAt: PLACED_AT,
        ...overrides,
    });
}

export function buildTransactionEntity(overrides: Partial<TransactionEntity> = {}): TransactionEntity {
    return new TransactionEntity({
        id: 55,
        region: "eg",
        orderId: 7,
        transactionType: TransactionType.CHARGE,
        method: TransactionMethod.ONLINE,
        providerId: 1,
        providerReferenceId: "TX-1001",
        status: TransactionStatus.SUCCEEDED,
        amount: 18000,
        currency: "EGP",
        srcAccId: 1,
        dstAccId: 100,
        isRefunded: false,
        refundedPaymentId: null,
        idempotencyKey: "kashier:TX-1001",
        createdAt: PLACED_AT,
        updatedAt: PLACED_AT,
        ...overrides,
    });
}

export function buildPaymentSessionEntity(overrides: Partial<PaymentSessionEntity> = {}): PaymentSessionEntity {
    return new PaymentSessionEntity({
        id: 9,
        region: "eg",
        orderId: 7,
        providerId: 1,
        providerSessionId: "ks_session_1",
        redirectUrl: "https://checkout.kashier.test/ks_session_1",
        amount: 18000,
        currency: "EGP",
        status: PaymentSessionStatus.INITIALIZED,
        rawInitPayload: {},
        rawLastPayload: null,
        createdAt: PLACED_AT,
        updatedAt: PLACED_AT,
        ...overrides,
    });
}

export function buildAgentEarningEntity(overrides: Partial<AgentEarningEntity> = {}): AgentEarningEntity {
    return new AgentEarningEntity({
        id: 3,
        region: "eg",
        agentId: 300,
        orderId: 7,
        amount: 1600,
        currency: "EGP",
        earnedAt: PLACED_AT,
        ...overrides,
    });
}

export function buildBalanceEntity(overrides: Partial<RestaurantBalanceEntity> = {}): RestaurantBalanceEntity {
    return new RestaurantBalanceEntity({
        restaurantId: 10,
        region: "eg",
        currency: "EGP",
        balance: 13500,
        updatedAt: PLACED_AT,
        ...overrides,
    });
}
