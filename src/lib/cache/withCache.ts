import {Request, Response, NextFunction} from "express";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {WithCacheOptions} from "./types";

/** `<region>:<namespace>` — region-prefixed like every other cache key. */
function scoped(region: string | undefined, namespace: string): string {
    return region ? `${region}:${namespace}` : namespace;
}

function generationKey(region: string | undefined, namespace: string): string {
    return `${scoped(region, namespace)}:gen`;
}

/**
 * Drops every cached response stored under `namespace` — all query-string
 * variants at once — by bumping its generation counter (a single INCR).
 * Entries of older generations are never read again and age out on their TTL.
 * An in-flight request that stores a response after the bump writes it under
 * the old generation, so it can't resurrect stale data either.
 */
export async function invalidateCacheNamespace(cache: ICacheProvider, region: string, namespace: string): Promise<void> {
    await cache.incr(generationKey(region, namespace));
}

export function withCache(ttl = 3600, userScoped = false, options: WithCacheOptions = {}) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const cacheProvider = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
            let key = `${req.method}:${req.originalUrl}`;
            if (userScoped) key = `${key}:${req.user?.userId}`;
            if (options.namespace) {
                const namespace = options.namespace(req);
                const generation = (await cacheProvider.get(generationKey(req.region, namespace))) ?? "0";
                key = `${scoped(req.region, namespace)}:v${generation}:${key}`;
            } else if (req.region) {
                key = `${req.region}:${key}`;
            }

            const cached = await cacheProvider.get(key);
            if (cached) {
                res.setHeader("X-Cache", "HIT");
                return res.status(200).json(JSON.parse(cached));
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: unknown) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    cacheProvider.set(key, JSON.stringify(body), ttl).catch(() => {});
                }
                res.setHeader("X-Cache", "MISS");
                return originalJson(body);
            }) as Response["json"];
            next();
        } catch (err) {
            next(err);
        }
    };
}
