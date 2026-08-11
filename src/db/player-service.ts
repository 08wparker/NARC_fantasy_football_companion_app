import { sql } from "drizzle-orm";

import * as schema from "./schema";
import type { DbOrTx } from "./types";

/**
 * Find or create a player by name.
 *
 * `players.espn_player_id` is nullable precisely so this can work: the
 * commissioner backfilling a 2025 trade types "Bijan Robinson" and gets a usable
 * row, months before anyone pastes an ESPN cookie. A later sync matches on name
 * and fills in the real id, at which point the manual row and the ESPN row are
 * the same row.
 *
 * Matching is case- and whitespace-insensitive so "bijan robinson" and
 * "Bijan  Robinson" don't become two players in the ledger.
 */
export async function findOrCreatePlayerByName(db: DbOrTx, rawName: string) {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("A player needs a name.");

  const existing = await db.query.players.findFirst({
    where: sql`lower(${schema.players.fullName}) = ${name.toLowerCase()}`,
  });
  if (existing) return existing;

  const [created] = await db
    .insert(schema.players)
    .values({ fullName: name, espnPlayerId: null })
    .returning();
  return created;
}

/** Typeahead source for the trade builder. */
export async function searchPlayers(db: DbOrTx, query: string, limit = 20) {
  const q = query.trim();
  if (!q) {
    return db.query.players.findMany({
      orderBy: (p, { asc }) => [asc(p.fullName)],
      limit,
    });
  }
  return db.query.players.findMany({
    where: sql`${schema.players.fullName} ilike ${"%" + q + "%"}`,
    orderBy: (p, { asc }) => [asc(p.fullName)],
    limit,
  });
}
