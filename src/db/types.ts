import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";

import type * as schema from "./schema";

type Schema = typeof schema;
type Relations = ExtractTablesWithRelations<Schema>;

/**
 * Driver-agnostic handles.
 *
 * Production runs on the Neon WebSocket pool; the derivation tests run on
 * PGlite (real Postgres compiled to WASM, so CHECK constraints and all).
 * Anything in src/db that takes a connection should accept these, never a
 * driver-specific type, so the same code is exercised by both.
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema, Relations>;

export type Tx = PgTransaction<PgQueryResultHKT, Schema, Relations>;

/** Accepts either a pooled connection or an open transaction. */
export type DbOrTx = Db | Tx;
