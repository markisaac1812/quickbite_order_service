import type {Server as HttpServer, IncomingHttpHeaders} from "http";
import type {connect} from "amqplib";
import type {CoreStub} from "./stubs/core-stub";
import type {KashierStub} from "./stubs/kashier-stub";

/** Running app + WS server + external-service stand-ins for one integration file. */
export interface TestServer {
    server: HttpServer;
    /** e.g. http://127.0.0.1:54321 — for socket.io-client connections */
    baseUrl: string;
    core: CoreStub;
    kashier: KashierStub;
    /** Clean slate between tests: both DB clusters, test Redis DB, stubs, permission cache. */
    reset(): Promise<void>;
    stop(): Promise<void>;
}

/** One request received by a stub server. */
export interface StubCall {
    method: string;
    /** originalUrl, query string included */
    path: string;
    body: unknown;
    headers: IncomingHttpHeaders;
}

export interface StubFailure {
    status: number;
    body: unknown;
    remaining: number;
}

export interface WaitForOptions {
    timeoutMs?: number;
    intervalMs?: number;
}

export type AmqpConnection = Awaited<ReturnType<typeof connect>>;

// ── DB seed shapes (snake_case = exactly what lands in the table) ─────────

export interface OrderRowSeed {
    id?: number;
    region: string;
    public_id: string;
    country_code: string;
    restaurant_id: number;
    restaurant_owner_id: number;
    branch_id: number;
    customer_id: number;
    customer_address_id: number;
    delivery_lat: number;
    delivery_lng: number;
    delivery_address_text_snapshot: string;
    branch_lat: number;
    branch_lng: number;
    status: string;
    subtotal: number;
    delivery_fee: number;
    service_fee: number;
    total: number;
    commission?: number;
    currency: string;
    payment_method: string;
    delivery_agent_id: number | null;
    created_at?: Date;
    accepted_at: Date | null;
    assigned_at?: Date | null;
    picked_at?: Date | null;
    delivered_at?: Date | null;
}

export interface SeededOrder {
    id: number;
    public_id: string;
    created_at: Date;
}

export interface OrderItemRowSeed {
    region: string;
    product_id: number;
    quantity: number;
    unit_price_snapshot: number;
    name_snapshot: string;
    image_url_snapshot: string | null;
    line_total: number;
}

export interface PaymentSessionRowSeed {
    region: string;
    provider_id: number;
    provider_session_id: string;
    redirect_url: string;
    amount: number;
    currency: string;
    status: string;
    created_at?: Date;
}

export interface TransactionRowSeed {
    region: string;
    order_id: number | null;
    transaction_type: string;
    method: string;
    provider_id: number | null;
    provider_reference_id: string | null;
    status: string;
    amount: number;
    currency: string;
    src_acc_id: number | null;
    dst_acc_id: number | null;
    idempotency_key: string | null;
    created_at?: Date;
}

export interface AgentEarningRowSeed {
    region: string;
    agent_id: number;
    order_id: number;
    amount: number;
    currency: string;
    earned_at?: Date;
}

export interface RestaurantBalanceRowSeed {
    restaurant_id: number;
    region: string;
    currency: string;
    balance: number;
}

export interface WebhookEventRowSeed {
    region: string;
    provider_id: number;
    provider_event_id: string;
    signature: string;
    payload: string;
    received_at?: Date;
}
