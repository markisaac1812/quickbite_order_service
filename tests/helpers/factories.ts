import {randomUUID} from "crypto";
import {dbFor} from "../../src/lib/knex/knex";
import {Cluster} from "../../src/lib/knex/types";
import {
    AgentEarningRowSeed,
    OrderItemRowSeed,
    OrderRowSeed,
    PaymentSessionRowSeed,
    RestaurantBalanceRowSeed,
    SeededOrder,
    TransactionRowSeed,
    WebhookEventRowSeed,
} from "./types";
import {ADDRESS_ID, BRANCH_ID, BRANCH_LAT, BRANCH_LNG, CUSTOMER_ID, OWNER_ID, RESTAURANT_ID} from "./fixtures";

/**
 * Seeds rows straight into a shard (no repos/services) so tests arrange
 * state independently of the code under test. `cluster` picks hot (default)
 * or the archive cluster.
 *
 * Archive seeds should pass an explicit `id` far from the hot sequence: the
 * cross-cluster list merge de-duplicates by order id.
 */
export async function insertOrder(region: string, overrides: Partial<OrderRowSeed> = {}, cluster: Cluster = "hot"): Promise<SeededOrder> {
    const row: OrderRowSeed = {
        region,
        public_id: randomUUID(),
        country_code: "EG",
        restaurant_id: RESTAURANT_ID,
        restaurant_owner_id: OWNER_ID,
        branch_id: BRANCH_ID,
        customer_id: CUSTOMER_ID,
        customer_address_id: ADDRESS_ID,
        delivery_lat: 30.0444,
        delivery_lng: 31.2357,
        delivery_address_text_snapshot: "12 Tahrir St, Cairo",
        branch_lat: BRANCH_LAT,
        branch_lng: BRANCH_LNG,
        status: "placed",
        subtotal: 15000,
        delivery_fee: 2000,
        service_fee: 1000,
        total: 18000,
        currency: "EGP",
        payment_method: "cod",
        delivery_agent_id: null,
        accepted_at: null,
        ...overrides,
    };
    const [inserted] = await dbFor(region, cluster)("orders").insert(row).returning(["id", "public_id", "created_at"]);
    return {id: Number(inserted.id), public_id: inserted.public_id, created_at: inserted.created_at};
}

export async function insertOrderItem(
    region: string,
    orderId: number,
    overrides: Partial<OrderItemRowSeed> = {},
    cluster: Cluster = "hot",
): Promise<void> {
    const row: OrderItemRowSeed = {
        region,
        product_id: 501,
        quantity: 2,
        unit_price_snapshot: 7500,
        name_snapshot: "Koshary (large)",
        image_url_snapshot: null,
        line_total: 15000,
        ...overrides,
    };
    await dbFor(region, cluster)("order_items").insert({...row, order_id: orderId});
}

export async function insertPaymentSession(
    region: string,
    orderId: number,
    overrides: Partial<PaymentSessionRowSeed> = {},
    cluster: Cluster = "hot",
): Promise<number> {
    const row: PaymentSessionRowSeed = {
        region,
        provider_id: 1, // kashier
        provider_session_id: `sess-${randomUUID()}`,
        redirect_url: "https://test-fep.kashier.io/session",
        amount: 18000,
        currency: "EGP",
        status: "initialized",
        ...overrides,
    };
    const [inserted] = await dbFor(region, cluster)("payment_sessions")
        .insert({...row, order_id: orderId, raw_init_payload: JSON.stringify({_id: row.provider_session_id})})
        .returning("id");
    return Number(inserted.id);
}

export async function insertTransaction(region: string, overrides: Partial<TransactionRowSeed> = {}, cluster: Cluster = "hot"): Promise<number> {
    const row: TransactionRowSeed = {
        region,
        order_id: null,
        transaction_type: "charge",
        method: "online",
        provider_id: 1,
        provider_reference_id: `TX-${randomUUID()}`,
        status: "succeeded",
        amount: 18000,
        currency: "EGP",
        src_acc_id: CUSTOMER_ID,
        dst_acc_id: OWNER_ID,
        idempotency_key: `seed:${randomUUID()}`,
        ...overrides,
    };
    const [inserted] = await dbFor(region, cluster)("transactions").insert(row).returning("id");
    return Number(inserted.id);
}

export async function insertAgentEarning(region: string, overrides: Partial<AgentEarningRowSeed> & {order_id: number; agent_id: number}, cluster: Cluster = "hot"): Promise<void> {
    const row: AgentEarningRowSeed = {region, amount: 1600, currency: "EGP", ...overrides};
    await dbFor(region, cluster)("agent_earnings").insert(row);
}

export async function insertBalance(region: string, overrides: Partial<RestaurantBalanceRowSeed> = {}): Promise<void> {
    const row: RestaurantBalanceRowSeed = {restaurant_id: RESTAURANT_ID, region, currency: "EGP", balance: 50000, ...overrides};
    await dbFor(region, "hot")("restaurant_balances").insert(row);
}

export async function insertWebhookEvent(region: string, overrides: Partial<WebhookEventRowSeed> = {}, cluster: Cluster = "hot"): Promise<void> {
    const row: WebhookEventRowSeed = {
        region,
        provider_id: 1,
        provider_event_id: `TX-${randomUUID()}`,
        signature: "deadbeef",
        payload: JSON.stringify({event: "pay", data: {status: "SUCCESS"}}),
        ...overrides,
    };
    await dbFor(region, cluster)("payment_webhook_events").insert(row);
}
