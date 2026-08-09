import * as schema from "./schema";
import type { Db } from "./types";

/**
 * Two drivers, chosen from the connection string.
 *
 *  - Neon (production): the WebSocket pool driver, NOT neon-http. neon-http
 *    cannot do interactive transactions — it only batches an array of queries —
 *    and every trade status transition must run rebuildDerivedState() inside the
 *    same transaction as the status write.
 *  - node-postgres (local dev): so you can develop against a local Postgres
 *    without a Neon project. Also supports real transactions.
 *
 * Both are driver-agnostic at the call site; see src/db/types.ts.
 */

const globalForDb = globalThis as unknown as {
  __narcPool?: { end: () => Promise<void> };
  __narcDb?: Db;
};

function isNeon(url: string) {
  return url.includes("neon.tech") || url.includes("neon.build");
}

function connect(): Db {
  if (globalForDb.__narcDb) return globalForDb.__narcDb;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }

  let instance: Db;
  let pool: { end: () => Promise<void> };

  if (isNeon(connectionString)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { neonConfig, Pool } = require("@neondatabase/serverless");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle } = require("drizzle-orm/neon-serverless");

    // Node 22 has a native global WebSocket; fall back to `ws` where it doesn't.
    if (typeof globalThis.WebSocket === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      neonConfig.webSocketConstructor = require("ws");
    }

    pool = new Pool({ connectionString });
    instance = drizzle(pool, { schema }) as Db;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle } = require("drizzle-orm/node-postgres");

    pool = new Pool({ connectionString });
    instance = drizzle(pool, { schema }) as Db;
  }

  // Reuse across hot reloads, otherwise every edit leaks connections.
  if (process.env.NODE_ENV !== "production") {
    globalForDb.__narcPool = pool;
    globalForDb.__narcDb = instance;
  }
  return instance;
}

/**
 * Lazily connected. `next build` imports every route module to collect
 * metadata, so connecting at module scope would make a build fail without a
 * live database, and would turn a missing env var into an opaque build error
 * instead of a clear runtime one.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = connect() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
