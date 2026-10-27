import {Knex} from "knex";
import {destroyAllShards, getArchiveShard, getHotShard, listConfiguredRegions} from "./shards";
import {Cluster, ClusterSlice} from "./types";

/**
 * Returns the hot-cluster connection for the given region.
 * Use this for transactional / strongly-consistent reads.
 */
export function db(region: string): Knex {
    return getHotShard(region);
}

/**
 * Returns the archive-cluster connection for the given region.
 * Holds rows created before `archiveCutoff()` (moved by the archival worker).
 */
export function dbArchive(region: string): Knex {
    return getArchiveShard(region);
}

export function dbFor(region: string, cluster: Cluster): Knex {
    return cluster === "archive" ? dbArchive(region) : db(region);
}

/**
 * Hot/archive boundary: start of the current UTC year. Rows created before it
 * belong to the archive cluster. Shared by the archival worker (what to move)
 * and the read path (where to look) so the two can never disagree.
 */
export function archiveCutoff(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
}

/**
 * The part of [from, to) that may live on the archive cluster, or null when
 * the range is entirely current-year. An open `from` means "current year"
 * (hot only) so unbounded list reads never fan out to the archive.
 *
 * Callers still read hot for the WHOLE range: prior-year rows stay hot until
 * the nightly run moves them (in-flight orders, the window right after New
 * Year, a run that hit its max runtime).
 */
export function archivedPortionOf(from: Date | undefined, to: Date | undefined, cutoff: Date = archiveCutoff()): ClusterSlice | null {
    if (!from || from >= cutoff) return null;
    return {cluster: "archive", from, to: to && to < cutoff ? to : cutoff};
}

export async function destroyAll(): Promise<void> {
    await destroyAllShards();
}

export interface ShardPing {
    region: string;
    cluster: "hot" | "archive";
    ok: boolean;
    error?: string;
}

export async function pingAll(): Promise<ShardPing[]> {
    const out: ShardPing[] = [];
    for (const region of listConfiguredRegions("hot")) {
        out.push(await pingOne(region, "hot"));
    }
    // Archive ping is best-effort; it may not exist in dev.
    for (const region of listConfiguredRegions("archive")) {
        out.push(await pingOne(region, "archive"));
    }
    return out;
}

async function pingOne(region: string, cluster: "hot" | "archive"): Promise<ShardPing> {
    try {
        const conn = cluster === "hot" ? getHotShard(region) : getArchiveShard(region);
        await conn.raw("SELECT 1");
        return {region, cluster, ok: true};
    } catch (err) {
        return {region, cluster, ok: false, error: (err as Error).message};
    }
}
