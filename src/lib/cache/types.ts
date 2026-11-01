import type {Request} from "express";

export interface WithCacheOptions {
    /**
     * Groups every cached response of the route (all query-string variants:
     * filters, cursors, limits) under one namespace, so a write can drop them
     * all at once with `invalidateCacheNamespace`. Return the region-free part,
     * e.g. `branch-orders:20` — withCache adds the region prefix.
     */
    namespace?: (req: Request) => string;
}
