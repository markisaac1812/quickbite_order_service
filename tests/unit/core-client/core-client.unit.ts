import {flattenAddress} from "../../../src/lib/core-client/address.client";
import {coreUnavailableError, coreUpstreamError} from "../../../src/lib/core-client/errors";
import {addressFixture} from "../../helpers/fixtures";

describe("flattenAddress", () => {
    it("joins building, street, city and country into the order's address snapshot", () => {
        // Arrange
        const address = addressFixture();

        // Act
        const text = flattenAddress(address);

        // Assert
        expect(text).toBe("12, Tahrir St, Cairo, Egypt");
    });

    it("skips empty parts", () => {
        // Arrange
        const address = addressFixture({building: "", street: ""});

        // Act
        const text = flattenAddress(address);

        // Assert
        expect(text).toBe("Cairo, Egypt");
    });
});

describe("core-client errors", () => {
    it("maps core 5xx to a retryable 503 and keeps 4xx status + body", () => {
        // Arrange
        const upstreamBody = '{"error":"BranchNotFound"}';

        // Act
        const unavailable = coreUnavailableError(502);
        const upstream = coreUpstreamError(404, upstreamBody);

        // Assert
        expect(unavailable).toMatchObject({statusCode: 503, message: "core-service 502"});
        expect(upstream).toMatchObject({statusCode: 404, message: `core-service 404: ${upstreamBody}`});
    });
});
