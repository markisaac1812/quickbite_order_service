import {Knex} from "knex";

export interface PaginationParams {
    cursor?: string;
    limit: number;
    sortBy: string;
    sortOrder: "asc" | "desc";
}

export interface FilterParams {
    field: string;
    operator: "eq" | "gt" | "lt" | "lte" | "gte" | "in" | "like";
    value: string | string[];
}

export interface PaginationMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}

function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Timestamps go out as ISO-8601 UTC. Any other sort value is stringified as-is.
 */
export function encodeCursor(value: unknown): string {
    return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * ISO cursors come back as Date so the driver binds them the same way it read
 * the column (TIMESTAMP without time zone); comparing against the raw "…Z"
 * string would shift the boundary by the server's UTC offset.
 */
function decodeCursor(cursor: string): string | Date {
    return ISO_TIMESTAMP.test(cursor) ? new Date(cursor) : cursor;
}

export function applyCursorPagination(
    query: Knex.QueryBuilder,
    params: PaginationParams,
): Knex.QueryBuilder {
    if (!params.sortBy) return query;
    const dbColumn = camelToSnake(params.sortBy);
    if (params.cursor) {
        const op = params.sortOrder === "asc" ? ">" : "<";
        query = query.where(dbColumn, op, decodeCursor(params.cursor));
    }
    return query.orderBy(dbColumn, params.sortOrder).limit(params.limit + 1);
}

export function applyFilters(
    query: Knex.QueryBuilder,
    filters: FilterParams[],
): Knex.QueryBuilder {
    for (const filter of filters) {
        switch (filter.operator) {
            case "eq":
                query.where(filter.field, filter.value);
                break;
            case "gt":
                query.where(filter.field, ">", filter.value);
                break;
            case "lt":
                query.where(filter.field, "<", filter.value);
                break;
            case "lte":
                query.where(filter.field, "<=", filter.value);
                break;
            case "gte":
                query.where(filter.field, ">=", filter.value);
                break;
            case "like":
                query.whereLike(filter.field, `%${filter.value}%`);
                break;
            case "in":
                query.whereIn(
                    filter.field,
                    Array.isArray(filter.value) ? filter.value : [filter.value],
                );
                break;
        }
    }
    return query;
}

export function buildPaginationResult<T>(
    rows: T[],
    limit: number,
    sortBy: string,
): {data: T[]; meta: PaginationMeta} {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;

    if (data.length > 0) {
        // Rows are raw DB rows (snake_case); sortBy is the camelCase API name.
        const lastItem = data[data.length - 1] as Record<string, unknown>;
        nextCursor = hasMore && lastItem ? encodeCursor(lastItem[camelToSnake(sortBy)] ?? lastItem[sortBy]) : null;
    }
    return {
        data,
        meta: {nextCursor, hasMore, count: data.length},
    };
}
