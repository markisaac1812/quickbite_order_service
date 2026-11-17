import type {Knex} from "knex";

type Shards = typeof import("../../../src/lib/knex/shards");

// env.ts reads process.env once at import, so each case loads fresh copies of
// env + shards with the variables it needs. Knex connects lazily, so building
// the instances below opens no connection.
function withShards(vars: {NODE_ENV?: string; DB_SSL?: string}, fn: (shards: Shards) => void): void {
    const saved = {NODE_ENV: process.env.NODE_ENV, DB_SSL: process.env.DB_SSL};
    const apply = (values: Record<string, string | undefined>) => {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    apply(vars);
    try {
        jest.isolateModules(() => fn(require("../../../src/lib/knex/shards")));
    } finally {
        apply(saved);
    }
}

function sslOf(conn: Knex) {
    return (conn.client.config.connection as Knex.PgConnectionConfig).ssl;
}

describe("shard connection ssl", () => {
    it("uses TLS on hot and archive shards in production (RDS)", () => {
        withShards({NODE_ENV: "production", DB_SSL: undefined}, ({getHotShard, getArchiveShard}) => {
            // Act
            const hot = getHotShard("eg");
            const archive = getArchiveShard("eg");

            // Assert
            expect(sslOf(hot)).toEqual({rejectUnauthorized: false});
            expect(sslOf(archive)).toEqual({rejectUnauthorized: false});
        });
    });

    it("stays plain outside production", () => {
        withShards({NODE_ENV: "development", DB_SSL: undefined}, ({getHotShard}) => {
            expect(sslOf(getHotShard("eg"))).toBe(false);
        });
    });

    it("lets DB_SSL override the default either way", () => {
        withShards({NODE_ENV: "production", DB_SSL: "false"}, ({getHotShard}) => {
            expect(sslOf(getHotShard("eg"))).toBe(false);
        });
        withShards({NODE_ENV: "development", DB_SSL: "true"}, ({getHotShard}) => {
            expect(sslOf(getHotShard("eg"))).toEqual({rejectUnauthorized: false});
        });
    });
});
