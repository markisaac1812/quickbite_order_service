export type Cluster = "hot" | "archive";

/**
 * One cluster's share of a requested time range. `from` is inclusive, `to`
 * exclusive; either may be undefined (unbounded on that side).
 */
export interface ClusterSlice {
    cluster: Cluster;
    from?: Date;
    to?: Date;
}
