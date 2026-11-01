import {AgentEarningsResponseDTO, DeliveryTaskResponseDTO} from "../../../src/app/agent/dto/agent.response.dto";
import {OrderStatus} from "../../../src/app/order/enums";
import {buildAgentEarningEntity, buildOrderEntity} from "../../helpers/entities";

describe("DeliveryTaskResponseDTO", () => {
    it("fills pickup from the branch and stamps progress timestamps", () => {
        // Arrange
        const order = buildOrderEntity({
            status: OrderStatus.PICKED,
            deliveryAgentId: 300,
            assignedAt: new Date("2026-05-10T12:21:00.000Z"),
            pickedAt: new Date("2026-05-10T12:30:00.000Z"),
        });
        const branch = {lat: 30.05, lng: 31.24, name: "Downtown", addressText: "1 Talaat Harb St, Cairo"};

        // Act
        const dto = DeliveryTaskResponseDTO.from(order, branch);

        // Assert
        expect(dto).toEqual({
            orderId: order.publicId,
            status: "picked",
            pickup: {branchId: 20, lat: 30.05, lng: 31.24, name: "Downtown", addressText: "1 Talaat Harb St, Cairo"},
            dropoff: {lat: 30.0444, lng: 31.2357, addressText: "12 Tahrir St, Cairo"},
            total: 18000,
            currency: "EGP",
            paymentMethod: "cod",
            assignedAt: "2026-05-10T12:21:00.000Z",
            pickedAt: "2026-05-10T12:30:00.000Z",
            deliveredAt: null,
        });
    });

    it("leaves pickup display fields null when the branch lookup failed", () => {
        // Arrange
        const order = buildOrderEntity({status: OrderStatus.ASSIGNED});

        // Act
        const dto = DeliveryTaskResponseDTO.from(order, undefined);

        // Assert
        expect(dto.pickup).toEqual({branchId: 20, lat: null, lng: null, name: null, addressText: null});
        expect(dto.assignedAt).toBeNull();
    });
});

describe("AgentEarningsResponseDTO", () => {
    it("totals the period and lists each earning", () => {
        // Arrange
        const from = new Date("2026-05-01T00:00:00.000Z");
        const to = new Date("2026-06-01T00:00:00.000Z");
        const items = [buildAgentEarningEntity(), buildAgentEarningEntity({id: 4, orderId: 8, amount: 1200})];

        // Act
        const dto = AgentEarningsResponseDTO.from(from, to, items, 2800);

        // Assert
        expect(dto.range).toEqual({from: "2026-05-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z"});
        expect(dto.totals).toEqual({count: 2, sum: 2800, currency: "EGP"});
        expect(dto.items[1]).toEqual({orderId: 8, amount: 1200, currency: "EGP", earnedAt: "2026-05-10T12:00:00.000Z"});
    });

    it("reports a null currency for a period with no earnings", () => {
        // Arrange
        const from = new Date("2026-05-01T00:00:00.000Z");
        const to = new Date("2026-06-01T00:00:00.000Z");

        // Act
        const dto = AgentEarningsResponseDTO.from(from, to, [], 0);

        // Assert
        expect(dto.totals).toEqual({count: 0, sum: 0, currency: null});
        expect(dto.items).toEqual([]);
    });
});
