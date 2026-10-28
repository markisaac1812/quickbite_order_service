import {randomUUID} from "crypto";
import {injectable, inject} from "tsyringe";
import {Server as IoServer} from "socket.io";
import {container} from "../../../lib/di/container";
import {TOKENS} from "../../../lib/di/tokens";
import {Knex} from "knex";
import {db, dbArchive, dbFor, archivedPortionOf} from "../../../lib/knex/knex";
import {ClusterSlice} from "../../../lib/knex/types";
import {assertRegion} from "../../../lib/sharding/regions";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {logger} from "../../../lib/logger/logger";
import {UnAuthorisedError} from "../../../lib/auth/errors";
import {sumMinor, multiplyMinor} from "../../../pkg/utils/money";
import {PaginationParams, FilterParams, PaginationMeta, encodeCursor} from "../../../lib/http/pagination/cursor-pagination";
import {
    getBranch,
    getBranchProducts,
    reserveStock as coreReserveStock,
    releaseStock as coreReleaseStock,
} from "../../../lib/core-client/branch.client";
import {CoreBranchProduct} from "../../../lib/core-client/types";
import {getCustomerAddress, flattenAddress} from "../../../lib/core-client/address.client";
import {CoreDataCacheService} from "./core-data-cache.service";
import {PaymentService} from "../../payment/service/payment.service";
import {assertTransition} from "./order-status.service";
import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {OrderStatus, PaymentMethod, Currency, StatusActor} from "../enums";
import {ActorContext, OrderLineDraft, OrderSliceFetcher, UnavailableItem} from "../types";
import {
    OrderNotFoundError,
    BranchNotAcceptingOrdersError,
    OnlinePaymentNotAvailableError,
    RegionMismatchError,
    outOfStockError,
    invalidStatusTransitionError,
} from "../errors";
import {env} from "../../../lib/config/env";
import {
    OrderResponseDTO,
    OrderDetailResponseDTO,
    OrderSummaryResponseDTO,
    OrderStatusResponseDTO,
} from "../dto/order.response.dto";
import {CreateOrderRequestDTO, UpdateOrderStatusRequestDTO} from "../dto/order.request.dto";
import {
    createOrder,
    findOrderByPublicId,
    updateOrderStatus,
    updateOrderStatusFrom,
    findOrdersByCustomer,
    findOrdersByRestaurantBranch,
} from "../repository/order.repo";
import {
    bulkInsertItems,
    findItemsByOrderIds,
    countItemsByOrderIds,
} from "../repository/order-item.repo";
import {insertOutboxEvent} from "../../../lib/events/outbox.repo";
import {EVENT_TYPES} from "../../../lib/events/event-types";

const SERVICE_FEE_MINOR = 1000; // 10.00 EGP / SAR — paid to the platform.

const RESTAURANT_ORDERS_CACHE_PREFIX = (region: string, branchId: number) =>
    `${region}:GET:/api/restaurant/orders?branchId=${branchId}`;

@injectable()
export class OrderService {
    constructor(
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
        @inject(TOKENS.CoreDataCacheService) private readonly coreData: CoreDataCacheService,
        @inject(TOKENS.PaymentService) private readonly paymentService: PaymentService,
    ) {}

    // Lazy access — WsServer is registered after the DI container builds the
    // routes (it depends on the http.Server, which is created in server.ts).
    private get io(): IoServer {
        return container.resolve<IoServer>(TOKENS.WsServer);
    }

    async placeOrder(actor: ActorContext, body: CreateOrderRequestDTO, region: string | undefined, correlationId?: string): Promise<OrderResponseDTO> {
        // 1. Branch metadata (drives shard region + accept flag + currency + delivery fee)
        const branch = await getBranch(body.branchId, correlationId);
        if (!branch.isActive || !branch.acceptOrders) throw BranchNotAcceptingOrdersError;
        if (branch.restaurantStatus !== "active") throw BranchNotAcceptingOrdersError;
        if (await this.coreData.isBranchRejectingOrders(body.branchId)) throw BranchNotAcceptingOrdersError;

        // The branch owns the shard. Branch country may arrive uppercase ("EG");
        // shard router is lowercase. A caller-supplied region that disagrees
        // would write the order to the wrong shard (and skip that region's
        // online-payment gate), so reject it instead of trusting it.
        const resolvedRegion = assertRegion(branch.region);
        if (region && region !== resolvedRegion) throw RegionMismatchError;

        // Online gateway is enabled per-region (env-driven). Anything else falls
        // back to COD-only — fail fast before we touch stock.
        if (body.paymentMethod === PaymentMethod.ONLINE && !env.payments.onlineRegions.has(resolvedRegion)) {
            throw OnlinePaymentNotAvailableError;
        }

        // 2. Address (snapshot lat/lng + flat text)
        const address = await getCustomerAddress(body.customerAddressId, correlationId);
        if (Number(address.userId) !== Number(actor.userId)) throw UnAuthorisedError;

        // 3. Products (single batch)
        const productIds = body.items.map((i) => i.productId);
        const products = await getBranchProducts(body.branchId, productIds, correlationId);
        const orderLineDrafts = this.buildOrderLineDrafts(body.items, products);

        // 4. Money
        const subtotal = sumMinor(orderLineDrafts.map((l) => l.lineTotal));
        const total = subtotal + branch.deliveryFee + SERVICE_FEE_MINOR;

        // 5. Reserve stock FIRST. If anything below this point fails, we MUST release.
        // Reserve is atomic on the core side (FOR UPDATE + 409 on underflow) so we
        // can't oversell. Using the publicId as the idempotency key means a retry
        // never double-reserves.
        const publicId = randomUUID();
        await coreReserveStock(
            body.branchId,
            body.items.map((i) => ({productId: i.productId, quantity: i.quantity})),
            publicId,
            correlationId,
        );

        // 6. Trx on the branch's region
        const conn = db(resolvedRegion);
        const trx = await conn.transaction();
        let order: OrderEntity;
        let items: OrderItemEntity[];
        try {
            order = await createOrder({
                region: resolvedRegion,
                publicId,
                countryCode: branch.region,
                restaurantId: Number(branch.restaurantId),
                restaurantOwnerId: Number(branch.restaurantOwnerId),
                branchId: Number(branch.id),
                customerId: actor.userId,
                customerAddressId: Number(address.id),
                deliveryLat: Number(address.lat),
                deliveryLng: Number(address.lng),
                deliveryAddressTextSnapshot: flattenAddress(address),
                branchLat: Number(branch.lat),
                branchLng: Number(branch.lng),
                status: body.paymentMethod === PaymentMethod.ONLINE ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED,
                subtotal,
                deliveryFee: branch.deliveryFee,
                serviceFee: SERVICE_FEE_MINOR,
                total,
                currency: branch.currency as Currency,
                paymentMethod: body.paymentMethod,
            }, trx);

            items = await bulkInsertItems(
                orderLineDrafts.map((l) => ({
                    region: resolvedRegion,
                    orderId: order.id,
                    productId: l.productId,
                    quantity: l.quantity,
                    unitPriceSnapshot: l.unitPrice,
                    nameSnapshot: l.name,
                    imageUrlSnapshot: l.imageUrl,
                    lineTotal: l.lineTotal,
                })),
                trx,
            );

            // Transactional outbox — only COD lands as `placed` here.
            // ONLINE orders start as `pending_payment` and emit `order.placed`
            // from the Kashier webhook after capture (see kashier-webhook.service.ts).
            if (order.status === OrderStatus.PLACED) {
                await insertOutboxEvent(trx, {
                    aggregateType: "order",
                    aggregateId: order.publicId,
                    eventType: EVENT_TYPES.ORDER_PLACED,
                    payload: buildOrderPlacedPayload(order, items),
                });
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            await this.releaseStockSafe(body.branchId, body.items, publicId, correlationId);
            throw err;
        }

        // 7. Online → init Kashier session. Rollback on failure (void order +
        // release stock) so the customer is never stranded.
        let paymentInfo;
        if (body.paymentMethod === PaymentMethod.ONLINE) {
            try {
                const result = await this.paymentService.initOnlinePayment(order);
                paymentInfo = {
                    sessionId: result.dto.sessionId,
                    providerSessionId: result.dto.providerSessionId,
                    redirectUrl: result.dto.redirectUrl,
                    expiresAt: result.dto.expiresAt,
                };
            } catch (err) {
                logger.warn("payment init failed; voiding order", {publicId: order.publicId, error: (err as Error).message});
                await this.voidOrderSafe(resolvedRegion, order.publicId);
                await this.releaseStockSafe(body.branchId, body.items, order.publicId, correlationId);
                throw err;
            }
        }

        // 8. Cache + WS
        await this.invalidateBranchOrdersCache(resolvedRegion, branch.id);
        if (body.paymentMethod === PaymentMethod.COD) {
            this.io
                .to(`branch:${branch.id}`)
                .emit("order.created", OrderSummaryResponseDTO.from(order, items.length));
        }

        return OrderResponseDTO.from(order, items, paymentInfo);
    }

    private async voidOrderSafe(region: string, publicId: string): Promise<void> {
        try {
            const trx = await db(region).transaction();
            try {
                await updateOrderStatus(publicId, OrderStatus.CANCELLED, "cancelled_at", trx);
                await trx.commit();
            } catch (e) {
                await trx.rollback();
                throw e;
            }
        } catch (err) {
            logger.error("voidOrderSafe failed (order remains in pending_payment)", {publicId, error: (err as Error).message});
        }
    }

    async getOrder(actor: ActorContext, region: string, publicId: string): Promise<OrderDetailResponseDTO> {
        let conn = db(region);
        let order = await findOrderByPublicId(publicId, conn);

        // Archived (prior-year) orders: admins and restaurant owners only, so
        // the customer order-tracking path never pays for an archive round-trip.
        if (!order && this.canReadArchive(actor)) {
            conn = dbArchive(region);
            order = await findOrderByPublicId(publicId, conn);
        }
        if (!order) throw OrderNotFoundError;

        this.assertReadAccess(actor, order);

        // Items live in the same cluster as their order (they're archived together).
        const items = await findItemsByOrderIds([order.id], conn);
        return OrderDetailResponseDTO.from(order, items);
    }

    async listCustomerOrders(actor: ActorContext, region: string, year: number, pagination: PaginationParams) {
        // Current year → hot only. Prior year → archive + hot (not-yet-archived rows).
        const yearStart = new Date(Date.UTC(year, 0, 1));
        const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
        return this.listAcrossClusters(region, yearStart, yearEnd, pagination, (conn, slice, page) =>
            findOrdersByCustomer(
                {customerId: actor.userId, yearStart: slice.from ?? yearStart, yearEnd: slice.to ?? yearEnd},
                page,
                conn,
            ),
        );
    }

    async listRestaurantOrders(
        _actor: ActorContext,
        region: string,
        restaurantId: number,
        branchId: number,
        status: OrderStatus | undefined,
        from: Date | undefined,
        to: Date | undefined,
        filters: FilterParams[],
        pagination: PaginationParams,
    ) {
        return this.listAcrossClusters(region, from, to, pagination, (conn, slice, page) =>
            findOrdersByRestaurantBranch(
                {restaurantId, branchId, status, from: slice.from, to: slice.to},
                page,
                filters,
                conn,
            ),
        );
    }

    async updateStatus(actor: ActorContext, region: string, publicId: string, body: UpdateOrderStatusRequestDTO): Promise<OrderStatusResponseDTO> {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        const statusActor = this.resolveStatusActor(actor, order);
        const {stamp} = assertTransition(order.status, body.status, {
            actor: statusActor,
            reason: body.reason,
            placedAt: order.createdAt,
            acceptedAt: order.acceptedAt,
        });

        const trx = await conn.transaction();
        let updated: OrderEntity;
        try {
            const moved = await updateOrderStatusFrom(order.publicId, order.status, body.status, stamp, trx);
            if (!moved) throw invalidStatusTransitionError(order.status, body.status);
            updated = moved;

            // Transactional outbox — pick the matching event type for the
            // new status. Same trx as the status update so we can't publish
            // a state we then roll back.
            const eventType = OUTBOX_EVENT_FOR_STATUS[body.status];
            if (eventType) {
                await insertOutboxEvent(trx, {
                    aggregateType: "order",
                    aggregateId: updated.publicId,
                    eventType,
                    payload: buildOrderTransitionPayload(updated, body.reason, statusActor),
                });
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        // Return reserved stock to core when the order dies before the kitchen
        // started on it. Out-of-trx and after commit (same as placement): the
        // status machine makes cancelled/rejected terminal, so this runs once.
        if (RELEASES_STOCK_ON.has(body.status) && STOCK_RELEASABLE_FROM.has(order.status)) {
            const items = await findItemsByOrderIds([order.id], conn);
            await this.releaseStockSafe(
                Number(order.branchId),
                items.map((i) => ({productId: Number(i.productId), quantity: Number(i.quantity)})),
                `release:${order.publicId}`,
            );
        }

        await this.invalidateBranchOrdersCache(region, order.branchId);

        const payload = OrderStatusResponseDTO.from(updated);
        this.io.to(`customer:${updated.customerId}`).emit("order.status_changed", payload);
        this.io.to(`branch:${updated.branchId}`).emit("order.status_changed", payload);

        return payload;
    }

    // ── private helpers ──────────────────────────────────────────────────

    /**
     * Pages a created_at-sorted order list across the hot and archive clusters.
     *
     * Hot is always read over the full range (it may still hold prior-year
     * rows the archival worker hasn't moved yet). The archive is read only for
     * the part of the range before the cutoff, so a current-year read stays a
     * single hot query. With two sources, each returns its top `limit`; the
     * global page is the top `limit` of their merge — standard 2-way merge, so
     * the cursor stays a plain created_at. Duplicates (a batch caught between
     * the archive and hot commits) are dropped by order id.
     *
     * At most 2 list queries + 2 batched item-count queries, run per cluster in
     * parallel. No N+1.
     */
    private async listAcrossClusters(
        region: string,
        from: Date | undefined,
        to: Date | undefined,
        pagination: PaginationParams,
        fetchSlice: OrderSliceFetcher,
    ): Promise<{data: OrderSummaryResponseDTO[]; meta: PaginationMeta}> {
        const sources: ClusterSlice[] = [{cluster: "hot", from, to}];
        const archived = archivedPortionOf(from, to);
        const cursor = pagination.cursor ? new Date(pagination.cursor) : undefined;
        if (archived && !(cursor && this.isSliceBeforeCursor(archived, cursor, pagination.sortOrder))) {
            sources.push(archived);
        }

        const pages = await Promise.all(
            sources.map(async (slice) => {
                const conn = dbFor(region, slice.cluster);
                return {conn, page: await fetchSlice(conn, slice, pagination)};
            }),
        );

        const seen = new Set<number>();
        const merged: {order: OrderEntity; conn: Knex}[] = [];
        for (const {conn, page} of pages) {
            for (const order of page.data) {
                if (seen.has(order.id)) continue;
                seen.add(order.id);
                merged.push({order, conn});
            }
        }
        if (pages.length > 1) {
            const dir = pagination.sortOrder === "asc" ? 1 : -1;
            merged.sort((a, b) => dir * (a.order.createdAt.getTime() - b.order.createdAt.getTime()));
        }

        const taken = merged.slice(0, pagination.limit);
        const hasMore = merged.length > pagination.limit || pages.some((p) => p.page.meta.hasMore);

        // Items live in the same cluster as their order → one count query per cluster.
        const idsByConn = new Map<Knex, number[]>();
        for (const {order, conn} of taken) {
            const ids = idsByConn.get(conn) ?? [];
            ids.push(order.id);
            idsByConn.set(conn, ids);
        }
        const countMaps = await Promise.all([...idsByConn].map(([conn, ids]) => countItemsByOrderIds(ids, conn)));
        const counts = new Map<number, number>();
        for (const m of countMaps) for (const [id, n] of m) counts.set(id, n);

        const last = taken[taken.length - 1]?.order;
        return {
            data: taken.map(({order}) => OrderSummaryResponseDTO.from(order, counts.get(order.id) ?? 0)),
            meta: {
                nextCursor: hasMore && last ? encodeCursor(last.createdAt) : null,
                hasMore,
                count: taken.length,
            },
        };
    }

    /** True if every row in the slice sorts at/before the cursor (already served) — skip the query. */
    private isSliceBeforeCursor(slice: ClusterSlice, cursor: Date, sortOrder: "asc" | "desc"): boolean {
        if (Number.isNaN(cursor.getTime())) return false;
        return sortOrder === "desc"
            ? !!slice.from && cursor <= slice.from
            : !!slice.to && cursor >= slice.to;
    }

    private canReadArchive(actor: ActorContext): boolean {
        return actor.role === "system_admin" || (actor.role === "restaurant_user" && actor.restaurantRole === "owner");
    }

    private buildOrderLineDrafts(
        requested: Array<{productId: number; quantity: number}>,
        products: CoreBranchProduct[],
    ): OrderLineDraft[] {
        const byProduct = new Map<number, CoreBranchProduct>();
        for (const p of products) byProduct.set(Number(p.productId), p);

        const unavailableItems: UnavailableItem[] = [];
        const drafts: OrderLineDraft[] = [];

        for (const it of requested) {
            const p = byProduct.get(it.productId);
            if (!p || !p.isAvailable) {
                unavailableItems.push({productId: it.productId, requested: it.quantity, available: 0});
                continue;
            }
            if (p.stock < it.quantity) {
                unavailableItems.push({productId: it.productId, requested: it.quantity, available: p.stock});
                continue;
            }
            drafts.push({
                productId: it.productId,
                quantity: it.quantity,
                unitPrice: p.price,
                lineTotal: multiplyMinor(p.price, it.quantity),
                name: p.name,
                imageUrl: p.imageUrl,
            });
        }
        if (unavailableItems.length > 0) throw outOfStockError(unavailableItems);
        return drafts;
    }

    private async releaseStockSafe(
        branchId: number,
        items: Array<{productId: number; quantity: number}>,
        idempotencyKey: string,
        correlationId?: string,
    ): Promise<void> {
        try {
            await coreReleaseStock(branchId, items, idempotencyKey, correlationId);
        } catch (err) {
            // Log loudly but do not mask the original error; release-stock failure
            // is observability/alerting territory, not a customer-facing error.
            logger.error("releaseStock failed (stock stays reserved in core)", {
                branchId,
                error: (err as Error).message,
            });
        }
    }

    private assertReadAccess(actor: ActorContext, order: OrderEntity) {
        if (actor.role === "system_admin") return;
        if (Number(actor.userId) === Number(order.customerId)) return;

        if (actor.role === "restaurant_user") {
            if (Number(actor.restaurantId) !== Number(order.restaurantId)) throw UnAuthorisedError;
            if (actor.restaurantRole === "owner") return;
            const branchIds = actor.branchIds ?? [];
            if (branchIds.includes(Number(order.branchId))) return;
        }
        throw UnAuthorisedError;
    }

    private resolveStatusActor(actor: ActorContext, order: OrderEntity): StatusActor {
        if (actor.role === "system_admin") return StatusActor.ADMIN;
        if (actor.role === "delivery_agent" && Number(actor.userId) === Number(order.deliveryAgentId)) return StatusActor.AGENT;
        if (actor.role === "restaurant_user") {
            if (Number(actor.restaurantId) !== Number(order.restaurantId)) throw UnAuthorisedError;
            if (actor.restaurantRole !== "owner") {
                const branchIds = actor.branchIds ?? [];
                if (!branchIds.includes(Number(order.branchId))) throw UnAuthorisedError;
            }
            return StatusActor.RESTAURANT_MEMBER;
        }
        if (Number(actor.userId) === Number(order.customerId)) return StatusActor.CUSTOMER;
        throw UnAuthorisedError;
    }

    private async invalidateBranchOrdersCache(region: string, branchId: number) {
        try {
            await this.cache.del(RESTAURANT_ORDERS_CACHE_PREFIX(region, branchId));
        } catch {}
    }
}

// ─── Outbox payload builders ─────────────────────────────────────────────────
// Kept as module-level helpers (not class methods) so they're easy to unit-test
// in isolation and don't drag a `this` context into the trx callback.

const OUTBOX_EVENT_FOR_STATUS: Partial<Record<OrderStatus, string>> = {
    [OrderStatus.ACCEPTED]: EVENT_TYPES.ORDER_ACCEPTED,
    [OrderStatus.REJECTED]: EVENT_TYPES.ORDER_REJECTED,
    [OrderStatus.CANCELLED]: EVENT_TYPES.ORDER_CANCELLED,
};

// Terminal "order died" statuses that hand reserved stock back to core —
// but only if the kitchen hadn't started (from `preparing` on, the food is
// already made and the stock is genuinely consumed).
const RELEASES_STOCK_ON = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REJECTED]);
const STOCK_RELEASABLE_FROM = new Set<OrderStatus>([
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PLACED,
    OrderStatus.ACCEPTED,
]);

/** Matches analytics-service contract (docs/api-contracts.md — order.placed payload). */
function buildOrderPlacedPayload(order: OrderEntity, items: OrderItemEntity[]) {
    return {
        orderId: order.publicId,
        region: order.region,
        countryCode: order.countryCode,
        restaurantId: Number(order.restaurantId),
        branchId: Number(order.branchId),
        customerId: Number(order.customerId),
        status: order.status,
        paymentMethod: order.paymentMethod,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        total: order.total,
        currency: order.currency,
        items: items.map((i) => ({
            productId: Number(i.productId),
            quantity: i.quantity,
            unitPrice: i.unitPriceSnapshot,
            lineTotal: i.lineTotal,
        })),
        placedAt: order.createdAt.toISOString(),
    };
}

function buildOrderTransitionPayload(order: OrderEntity, reason: string | undefined, actor: StatusActor) {
    return {
        orderId: order.publicId,
        region: order.region,
        restaurantId: Number(order.restaurantId),
        branchId: Number(order.branchId),
        customerId: Number(order.customerId),
        status: order.status,
        reason: reason ?? null,
        actor,
        occurredAt: order.updatedAt.toISOString(),
    };
}
