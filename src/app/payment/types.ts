import {PaymentSessionStatus, TransactionType, TransactionMethod, TransactionStatus} from "./enums";
import {PaymentSessionEntity} from "./entity/payment-session.entity";
import {TransactionEntity} from "./entity/transaction.entity";
import {PaymentInitResponseDTO} from "./dto/payment.response.dto";

/** Result of `PaymentService.initOnlinePayment` — the session plus its response DTO. */
export interface InitOnlinePaymentResult {
    session: PaymentSessionEntity;
    expiresAt: string;
    dto: PaymentInitResponseDTO;
}

/** A transaction joined to its order's restaurant id. */
export interface TransactionWithOwner {
    transaction: TransactionEntity;
    /** The owning order's restaurant id (NULL for txs not tied to an order, e.g. payouts). */
    restaurantId: number | null;
}

export interface CreateSessionRowInput {
    region: string;
    orderId: number;
    providerId: number;
    providerSessionId: string;
    redirectUrl: string;
    amount: number;
    currency: string;
    status: PaymentSessionStatus;
    rawInitPayload: unknown;
}

export interface UpdateSessionRowInput {
    status: PaymentSessionStatus;
    rawLastPayload?: unknown;
}

export interface CreateTransactionInput {
    region: string;
    orderId: number | null;
    transactionType: TransactionType;
    method: TransactionMethod;
    providerId: number | null;
    providerReferenceId: string | null;
    status: TransactionStatus;
    amount: number;
    currency: string;
    srcAccId: number | null;
    dstAccId: number | null;
    idempotencyKey: string | null;
}

export interface RecordWebhookInput {
    region: string;
    providerId: number;
    providerEventId: string;
    signature: string;
    payload: unknown;
}
