import {assertTransition} from "../../../src/app/order/service/order-status.service";
import {OrderStatus, StatusActor} from "../../../src/app/order/enums";

const SECOND = 1000;

describe("assertTransition (order status machine)", () => {
    it("returns the column to stamp when a restaurant member accepts a placed order", () => {
        // Arrange
        const ctx = {actor: StatusActor.RESTAURANT_MEMBER};

        // Act
        const result = assertTransition(OrderStatus.PLACED, OrderStatus.ACCEPTED, ctx);

        // Assert
        expect(result).toEqual({stamp: "accepted_at"});
    });

    it("rejects a transition that is not in the matrix with 409", () => {
        // Arrange
        const ctx = {actor: StatusActor.ADMIN};

        // Act
        const act = () => assertTransition(OrderStatus.PLACED, OrderStatus.DELIVERED, ctx);

        // Assert
        expect(act).toThrow(expect.objectContaining({
            statusCode: 409,
            message: "InvalidStatusTransition: placed -> delivered",
        }));
    });

    it("rejects an allowed transition when the actor is not permitted to drive it", () => {
        // Arrange — placed -> accepted exists, but only restaurant members may do it
        const ctx = {actor: StatusActor.CUSTOMER};

        // Act
        const act = () => assertTransition(OrderStatus.PLACED, OrderStatus.ACCEPTED, ctx);

        // Assert
        expect(act).toThrow(expect.objectContaining({
            statusCode: 409,
            message: "InvalidStatusTransition: placed -> accepted",
        }));
    });

    it("requires a non-blank reason to reject an order", () => {
        // Arrange
        const ctx = {actor: StatusActor.RESTAURANT_MEMBER, reason: "   "};

        // Act
        const act = () => assertTransition(OrderStatus.PLACED, OrderStatus.REJECTED, ctx);

        // Assert
        expect(act).toThrow(expect.objectContaining({
            statusCode: 400,
            message: "Reason required for this transition",
        }));
    });

    it("lets the customer cancel a placed order inside the 60s window", () => {
        // Arrange
        const ctx = {
            actor: StatusActor.CUSTOMER,
            reason: "ordered by mistake",
            placedAt: new Date(Date.now() - 10 * SECOND),
            acceptedAt: null,
        };

        // Act
        const result = assertTransition(OrderStatus.PLACED, OrderStatus.CANCELLED, ctx);

        // Assert
        expect(result).toEqual({stamp: "cancelled_at"});
    });

    it("blocks the customer from cancelling once the 60s window has passed", () => {
        // Arrange
        const ctx = {
            actor: StatusActor.CUSTOMER,
            reason: "changed my mind",
            placedAt: new Date(Date.now() - 5 * 60 * SECOND),
            acceptedAt: null,
        };

        // Act
        const act = () => assertTransition(OrderStatus.PLACED, OrderStatus.CANCELLED, ctx);

        // Assert
        expect(act).toThrow(expect.objectContaining({
            statusCode: 409,
            message: "CancellationWindowExpired",
        }));
    });

    it("blocks the customer from cancelling once the restaurant has accepted", () => {
        // Arrange — still inside 60s, but accepted_at is set
        const ctx = {
            actor: StatusActor.CUSTOMER,
            reason: "too slow",
            placedAt: new Date(Date.now() - 5 * SECOND),
            acceptedAt: new Date(),
        };

        // Act
        const act = () => assertTransition(OrderStatus.PLACED, OrderStatus.CANCELLED, ctx);

        // Assert
        expect(act).toThrow(expect.objectContaining({statusCode: 409, message: "CancellationWindowExpired"}));
    });

    it("lets the system confirm a paid order without stamping a column", () => {
        // Arrange
        const ctx = {actor: StatusActor.SYSTEM};

        // Act
        const result = assertTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PLACED, ctx);

        // Assert
        expect(result).toEqual({stamp: null});
    });

    it("lets the assigned agent mark a picked order delivered", () => {
        // Arrange
        const ctx = {actor: StatusActor.AGENT};

        // Act
        const result = assertTransition(OrderStatus.PICKED, OrderStatus.DELIVERED, ctx);

        // Assert
        expect(result).toEqual({stamp: "delivered_at"});
    });
});
