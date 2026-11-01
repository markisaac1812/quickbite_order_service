import knex, {Knex} from "knex";
import {parseFilters, parsePaginationQuery} from "../../../src/lib/http/pagination/parse-query";
import {
    applyCursorPagination,
    applyFilters,
    buildPaginationResult,
    encodeCursor,
} from "../../../src/lib/http/pagination/cursor-pagination";

// Query builder only — no connection is ever opened; we inspect toSQL().
const qb: Knex = knex({client: "pg"});

afterAll(async () => {
    await qb.destroy();
});

describe("parsePaginationQuery", () => {
    it("falls back to createdAt / desc / 20 when the query is empty", () => {
        // Arrange
        const query = {};

        // Act
        const params = parsePaginationQuery(query);

        // Assert
        expect(params).toEqual({cursor: undefined, limit: 20, sortBy: "createdAt", sortOrder: "desc"});
    });

    it("caps the limit at 100 and honours an allowed sortBy and asc order", () => {
        // Arrange
        const query = {limit: "500", sortBy: "total", sortOrder: "asc", cursor: "abc"};

        // Act
        const params = parsePaginationQuery(query, ["createdAt", "total"]);

        // Assert
        expect(params).toEqual({cursor: "abc", limit: 100, sortBy: "total", sortOrder: "asc"});
    });

    it("ignores a non-positive limit and a sortBy that is not allow-listed", () => {
        // Arrange
        const query = {limit: "-5", sortBy: "password_hash"};

        // Act
        const params = parsePaginationQuery(query);

        // Assert
        expect(params.limit).toBe(20);
        expect(params.sortBy).toBe("createdAt");
    });
});

describe("parseFilters", () => {
    it("keeps only allow-listed fields and known operators", () => {
        // Arrange
        const query = {filter: {status: {eq: "placed", drop_table: "x"}, secret: {eq: "1"}}};

        // Act
        const filters = parseFilters(query, ["status"]);

        // Assert
        expect(filters).toEqual([{field: "status", operator: "eq", value: "placed"}]);
    });

    it("returns no filters when the query has none", () => {
        // Arrange
        const query = {limit: "10"};

        // Act
        const filters = parseFilters(query, ["status"]);

        // Assert
        expect(filters).toEqual([]);
    });
});

describe("encodeCursor", () => {
    it("encodes dates as ISO-8601 UTC and anything else verbatim", () => {
        // Arrange
        const date = new Date("2026-03-01T08:30:00.000Z");

        // Act
        const encoded = [encodeCursor(date), encodeCursor(42)];

        // Assert
        expect(encoded).toEqual(["2026-03-01T08:30:00.000Z", "42"]);
    });
});

describe("buildPaginationResult", () => {
    it("drops the look-ahead row and cursors on the last row's snake_case column", () => {
        // Arrange — limit 2, repo fetched limit + 1
        const rows = [
            {id: 3, created_at: new Date("2026-03-03T00:00:00.000Z")},
            {id: 2, created_at: new Date("2026-03-02T00:00:00.000Z")},
            {id: 1, created_at: new Date("2026-03-01T00:00:00.000Z")},
        ];

        // Act
        const result = buildPaginationResult(rows, 2, "createdAt");

        // Assert
        expect(result.data.map((r) => r.id)).toEqual([3, 2]);
        expect(result.meta).toEqual({nextCursor: "2026-03-02T00:00:00.000Z", hasMore: true, count: 2});
    });

    it("has no next cursor on the last page", () => {
        // Arrange
        const rows = [{id: 1, created_at: new Date("2026-03-01T00:00:00.000Z")}];

        // Act
        const result = buildPaginationResult(rows, 2, "createdAt");

        // Assert
        expect(result.meta).toEqual({nextCursor: null, hasMore: false, count: 1});
    });
});

describe("applyCursorPagination", () => {
    it("seeks past an ISO cursor (bound as a Date) and over-fetches by one", () => {
        // Arrange
        const query = qb("orders").select("id");
        const params = {cursor: "2026-03-02T00:00:00.000Z", limit: 2, sortBy: "createdAt", sortOrder: "desc" as const};

        // Act
        const {sql, bindings} = applyCursorPagination(query, params).toSQL();

        // Assert
        expect(sql).toBe('select "id" from "orders" where "created_at" < ? order by "created_at" desc limit ?');
        expect(bindings[0]).toEqual(new Date("2026-03-02T00:00:00.000Z"));
        expect(bindings[1]).toBe(3);
    });

    it("uses > for ascending order and binds non-ISO cursors as strings", () => {
        // Arrange
        const query = qb("orders").select("id");
        const params = {cursor: "1500", limit: 10, sortBy: "total", sortOrder: "asc" as const};

        // Act
        const {sql, bindings} = applyCursorPagination(query, params).toSQL();

        // Assert
        expect(sql).toBe('select "id" from "orders" where "total" > ? order by "total" asc limit ?');
        expect(bindings).toEqual(["1500", 11]);
    });
});

describe("applyFilters", () => {
    it("translates every supported operator into SQL", () => {
        // Arrange
        const query = qb("orders").select("id");
        const filters = [
            {field: "status", operator: "eq" as const, value: "placed"},
            {field: "total", operator: "gt" as const, value: "100"},
            {field: "total", operator: "lt" as const, value: "900"},
            {field: "subtotal", operator: "gte" as const, value: "50"},
            {field: "subtotal", operator: "lte" as const, value: "800"},
            {field: "currency", operator: "like" as const, value: "EG"},
            {field: "branch_id", operator: "in" as const, value: ["20", "21"]},
            {field: "region", operator: "in" as const, value: "eg"},
        ];

        // Act
        const {sql, bindings} = applyFilters(query, filters).toSQL();

        // Assert
        expect(sql).toBe(
            'select "id" from "orders" where "status" = ? and "total" > ? and "total" < ?' +
            ' and "subtotal" >= ? and "subtotal" <= ? and "currency" like ?' +
            ' and "branch_id" in (?, ?) and "region" in (?)',
        );
        expect(bindings).toEqual(["placed", "100", "900", "50", "800", "%EG%", "20", "21", "eg"]);
    });
});
