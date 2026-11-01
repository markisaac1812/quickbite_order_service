import "reflect-metadata";
import {db} from "../../../src/lib/knex/knex";
import {container} from "../../../src/lib/di/container";
import {TOKENS} from "../../../src/lib/di/tokens";
import {PaymentService} from "../../../src/app/payment/service/payment.service";
import {findOrderByPublicId} from "../../../src/app/order/repository/order.repo";
import {OrderEntity} from "../../../src/app/order/entity/order.entity";
import {startTestServer} from "../../helpers/server";
import {insertOrder, insertPaymentSession} from "../../helpers/factories";
import {TestServer} from "../../helpers/types";

const REGION = "eg";
const FIFTEEN_MIN = 15 * 60_000;

describe("PaymentService.initOnlinePayment", () => {
    let app: TestServer;
    let payments: PaymentService;

    const seedOnlineOrder = async (): Promise<OrderEntity> => {
        const seeded = await insertOrder(REGION, {status: "pending_payment", payment_method: "online"});
        return (await findOrderByPublicId(seeded.public_id, db(REGION)))!;
    };

    beforeAll(async () => {
        app = await startTestServer();
        payments = container.resolve<PaymentService>(TOKENS.PaymentService);
    });

    afterAll(async () => {
        await app.stop();
    });

    beforeEach(async () => {
        await app.reset();
    });

    it("re-uses a live session instead of minting a second one at Kashier", async () => {
        // Arrange
        const order = await seedOnlineOrder();
        const createdAt = new Date(Date.now() - 60_000);
        await insertPaymentSession(REGION, order.id, {provider_session_id: "ks_existing", status: "pending", created_at: createdAt});

        // Act
        const result = await payments.initOnlinePayment(order);

        // Assert
        expect(result.dto.providerSessionId).toBe("ks_existing");
        expect(new Date(result.expiresAt).getTime()).toBe(result.session.createdAt.getTime() + FIFTEEN_MIN);
        expect(app.kashier.calls).toHaveLength(0);
    });

    it("computes the expiry itself when Kashier does not return one", async () => {
        // Arrange
        const order = await seedOnlineOrder();
        app.kashier.responseOverride = {_id: "ks_no_expiry", sessionUrl: "https://checkout.kashier.test/ks_no_expiry"};
        const before = Date.now();

        // Act
        const result = await payments.initOnlinePayment(order);

        // Assert
        expect(result.dto.providerSessionId).toBe("ks_no_expiry");
        const expiresAt = new Date(result.expiresAt).getTime();
        expect(expiresAt).toBeGreaterThanOrEqual(before + FIFTEEN_MIN - 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + FIFTEEN_MIN + 1000);
    });

    it("maps a malformed Kashier response to 503 and stores no session", async () => {
        // Arrange
        const order = await seedOnlineOrder();
        app.kashier.responseOverride = {status: "CREATED"}; // no _id / sessionUrl

        // Act
        const act = payments.initOnlinePayment(order);

        // Assert
        await expect(act).rejects.toMatchObject({statusCode: 503, message: "Payment provider unavailable"});
        expect(await db(REGION)("payment_sessions").count<{count: string}[]>("* as count")).toEqual([{count: "0"}]);
    });
});
