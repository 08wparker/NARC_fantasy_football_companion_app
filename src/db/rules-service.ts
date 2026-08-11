import { and, eq, max } from "drizzle-orm";

import * as schema from "./schema";
import type { Db, DbOrTx } from "./types";

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

/**
 * The rules the league has agreed so far.
 *
 * Seeded rather than hardcoded in the UI, so the commissioner can edit any of
 * them without a deploy — including the ones that predate this app.
 */
export const DEFAULT_RULES = [
  "Each team keeps 3 players from the previous season.",
  "The draft is 16 rounds, in snake order.",
  "Draft picks may only be traded for the current and next season. Picks two or more years out cannot be traded.",
  "Keeper rights cannot be traded separately from the player. If you trade the player, the keeper right goes with them.",
  "Keeper slots cannot be traded. Every team keeps the same number.",
  "A rule change passes with two-thirds of all 12 franchises voting yes. Abstaining and not voting have the same effect as voting no.",
  "Trades are recorded in this app, not on ESPN. ESPN cannot represent a traded draft pick, so the ledger here is the authoritative record.",
  "A trade takes effect once the other side confirms it. The commissioner can void a confirmed trade, and the reason stays on the record.",
] as const;

export async function listRules(db: DbOrTx, leagueId: number) {
  return db.query.rules.findMany({
    where: eq(schema.rules.leagueId, leagueId),
    orderBy: (r, { asc }) => [asc(r.sortOrder), asc(r.id)],
  });
}

async function nextSortOrder(db: DbOrTx, leagueId: number) {
  const [row] = await db
    .select({ maxOrder: max(schema.rules.sortOrder) })
    .from(schema.rules)
    .where(eq(schema.rules.leagueId, leagueId));
  return (row?.maxOrder ?? -1) + 1;
}

export async function addRule(
  db: DbOrTx,
  leagueId: number,
  body: string,
  opts: { createdByUserId?: number; sourceProposalId?: number } = {},
) {
  const text = body.trim();
  if (!text) throw new RuleError("A rule needs some text.");

  const [rule] = await db
    .insert(schema.rules)
    .values({
      leagueId,
      body: text,
      sortOrder: await nextSortOrder(db, leagueId),
      createdByUserId: opts.createdByUserId ?? null,
      sourceProposalId: opts.sourceProposalId ?? null,
    })
    .returning();
  return rule;
}

export async function updateRule(db: DbOrTx, leagueId: number, ruleId: number, body: string) {
  const text = body.trim();
  if (!text) throw new RuleError("A rule needs some text.");

  const existing = await db.query.rules.findFirst({
    where: and(eq(schema.rules.id, ruleId), eq(schema.rules.leagueId, leagueId)),
  });
  if (!existing) throw new RuleError("That rule does not exist.");

  await db
    .update(schema.rules)
    .set({ body: text, updatedAt: new Date() })
    .where(eq(schema.rules.id, ruleId));
}

export async function deleteRule(db: DbOrTx, leagueId: number, ruleId: number) {
  const existing = await db.query.rules.findFirst({
    where: and(eq(schema.rules.id, ruleId), eq(schema.rules.leagueId, leagueId)),
  });
  if (!existing) throw new RuleError("That rule does not exist.");
  await db.delete(schema.rules).where(eq(schema.rules.id, ruleId));
}

/**
 * Move a rule one place up or down.
 *
 * Swaps sort_order with its neighbour rather than renumbering everything, then
 * normalizes. There is no unique index on sort_order, so a transient collision
 * is harmless here — unlike draft_order, where it would be a constraint error.
 */
export async function moveRule(
  db: Db,
  leagueId: number,
  ruleId: number,
  direction: "up" | "down",
) {
  const ordered = await listRules(db, leagueId);
  const index = ordered.findIndex((r) => r.id === ruleId);
  if (index === -1) throw new RuleError("That rule does not exist.");

  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= ordered.length) return; // already at the end

  const reordered = [...ordered];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  await db.transaction(async (tx) => {
    for (const [i, rule] of reordered.entries()) {
      await tx.update(schema.rules).set({ sortOrder: i }).where(eq(schema.rules.id, rule.id));
    }
  });
}

/** Idempotent: adds the default rulebook only if the league has no rules yet. */
export async function seedDefaultRules(db: DbOrTx, leagueId: number) {
  const existing = await listRules(db, leagueId);
  if (existing.length > 0) return existing;

  for (const body of DEFAULT_RULES) {
    await addRule(db, leagueId, body);
  }
  return listRules(db, leagueId);
}
