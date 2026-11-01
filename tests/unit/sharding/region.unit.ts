import type {Request, Response} from "express";
import {assertRegion, isRegion, normalizeRegion} from "../../../src/lib/sharding/regions";
import {requireConcreteRegion, requireRegion, resolveRegion} from "../../../src/lib/sharding/region-resolver";

/** Plain request shape — enough for the middleware, no express app involved. */
function requestWith(headers: Record<string, string | string[]>, query: Record<string, unknown> = {}): Request {
    return {headers, query} as unknown as Request;
}

const res = {} as Response;

describe("regions", () => {
    it("normalises country codes to the lowercase shard key", () => {
        // Arrange
        const inputs = ["EG", "eg", undefined, null];

        // Act
        const normalised = inputs.map(normalizeRegion);

        // Assert
        expect(normalised).toEqual(["eg", "eg", undefined, undefined]);
    });

    it("only recognises configured regions", () => {
        // Arrange — .env.test configures REGIONS=eg
        const candidates = ["EG", "sa", ""];

        // Act
        const known = candidates.map(isRegion);

        // Assert
        expect(known).toEqual([true, false, false]);
    });

    it("asserts a region or throws naming the known ones", () => {
        // Arrange
        const good = "Eg";

        // Act
        const resolved = assertRegion(good);
        const act = () => assertRegion("mars");

        // Assert
        expect(resolved).toBe("eg");
        expect(act).toThrow('Unknown region: "mars". Known: eg');
    });
});

describe("resolveRegion middleware", () => {
    it("prefers the X-Region header over ?region=", () => {
        // Arrange
        const req = requestWith({"x-region": "EG"}, {region: "sa"});
        let nextCalled = false;

        // Act
        resolveRegion(req, res, () => { nextCalled = true; });

        // Assert
        expect(req.region).toBe("eg");
        expect(nextCalled).toBe(true);
    });

    it("reads ?region= for callers that cannot set headers (webhooks)", () => {
        // Arrange
        const req = requestWith({}, {region: "eg"});

        // Act
        resolveRegion(req, res, () => {});

        // Assert
        expect(req.region).toBe("eg");
    });

    it("keeps the admin fan-out value 'all' and ignores unknown regions", () => {
        // Arrange
        const fanOut = requestWith({"x-region": ["ALL", "eg"]});
        const unknown = requestWith({"x-region": "mars"});

        // Act
        resolveRegion(fanOut, res, () => {});
        resolveRegion(unknown, res, () => {});

        // Assert
        expect(fanOut.region).toBe("all");
        expect(unknown.region).toBeUndefined();
    });
});

describe("requireRegion / requireConcreteRegion", () => {
    it("lets 'all' through requireRegion but not requireConcreteRegion", () => {
        // Arrange
        const req = requestWith({});
        req.region = "all";
        let passed = false;

        // Act
        requireRegion(req, res, () => { passed = true; });
        const act = () => requireConcreteRegion(req, res, () => {});

        // Assert
        expect(passed).toBe(true);
        expect(act).toThrow(expect.objectContaining({statusCode: 400}));
    });

    it("rejects a request with no region at all", () => {
        // Arrange
        const req = requestWith({});

        // Act
        const act = () => requireRegion(req, res, () => {});

        // Assert
        expect(act).toThrow(expect.objectContaining({
            statusCode: 400,
            message: "Region not resolved. Provide ?region= or X-Region header, or authenticate.",
        }));
    });
});
