import { eq, inArray } from "drizzle-orm";

import * as schema from "./schema";
import type { DbOrTx } from "./types";

export type TradeAssetInput =
  | { kind: "draft_pick"; fromTeamId: number; toTeamId: number; draftPickId: number; note?: string }
  | { kind: "player"; fromTeamId: number; toTeamId: number; playerId: number; note?: string }
  | {
      kind: "keeper_right";
      fromTeamId: number;
      toTeamId: number;
      playerId: number;
      seasonId: number;
      note?: string;
    }
  | {
      kind: "keeper_slot";
      fromTeamId: number;
      toTeamId: number;
      seasonId: number;
      slotCount: number;
      note?: string;
    }
  | { kind: "draft_slot_swap"; fromTeamId: number; toTeamId: number; seasonId: number; note?: string };

/** Every team that gives or receives anything in this trade. */
export function participantsOf(assets: TradeAssetInput[]): number[] {
  return [...new Set(assets.flatMap((a) => [a.fromTeamId, a.toTeamId]))];
}

/**
 * Seasons whose derived state this trade can move. Only draft_pick and
 * draft_slot_swap assets materialize anything, but keeper assets still scope to
 * a season for display, so we include them and let the rebuild no-op.
 */
export async function affectedSeasonIds(
  db: DbOrTx,
  assets: Array<{ kind: string; draftPickId?: number | null; seasonId?: number | null }>,
): Promise<number[]> {
  const ids = new Set<number>();
  for (const a of assets) if (a.seasonId) ids.add(a.seasonId);

  const pickIds = assets
    .map((a) => a.draftPickId)
    .filter((id): id is number => typeof id === "number");

  if (pickIds.length > 0) {
    const picks = await db
      .select({ seasonId: schema.draftPicks.seasonId })
      .from(schema.draftPicks)
      .where(inArray(schema.draftPicks.id, pickIds));
    for (const p of picks) ids.add(p.seasonId);
  }

  return [...ids];
}

export type TradeValidationIssue = { severity: "error" | "warning"; message: string };

/**
 * Pre-insert sanity checks, run when a trade is logged.
 *
 * These are advisory guardrails on top of the database CHECK constraints, not a
 * replacement for them — they exist to catch mistakes while the manager is
 * still looking at the form, with a message a human can act on.
 */
export async function validateTradeAssets(
  db: DbOrTx,
  leagueId: number,
  assets: TradeAssetInput[],
  opts: { currentYear?: number } = {},
): Promise<TradeValidationIssue[]> {
  const issues: TradeValidationIssue[] = [];

  if (assets.length === 0) {
    issues.push({ severity: "error", message: "A trade needs at least one asset." });
    return issues;
  }

  /**
   * Neither flavour of keeper asset is tradeable.
   *
   * Rights follow the player; slots are fixed at 3 per team and cannot move at
   * all. Both enum values survive so any historical row stays readable — only
   * new ones are refused.
   */
  if (assets.some((a) => a.kind === "keeper_right")) {
    issues.push({
      severity: "error",
      message:
        "Keeper rights cannot be traded separately from the player. Trade the player instead — " +
        "the keeper right follows them.",
    });
  }

  if (assets.some((a) => a.kind === "keeper_slot")) {
    issues.push({
      severity: "error",
      message: "Keeper slots cannot be traded. Every team keeps the same number.",
    });
  }

  const participants = participantsOf(assets);
  if (participants.length < 2) {
    issues.push({ severity: "error", message: "A trade needs at least two teams." });
  }

  const teams = await db.query.teams.findMany({ where: eq(schema.teams.leagueId, leagueId) });
  const teamById = new Map(teams.map((t) => [t.id, t]));
  for (const id of participants) {
    if (!teamById.has(id)) {
      issues.push({ severity: "error", message: `Team ${id} is not in this league.` });
    }
  }

  // Draft picks: the sender must currently hold them, and no pick may appear twice.
  const pickAssets = assets.filter(
    (a): a is Extract<TradeAssetInput, { kind: "draft_pick" }> => a.kind === "draft_pick",
  );
  const seenPicks = new Set<number>();
  if (pickAssets.length > 0) {
    const picks = await db.query.draftPicks.findMany({
      where: inArray(
        schema.draftPicks.id,
        pickAssets.map((a) => a.draftPickId),
      ),
      with: { season: true },
    });
    const pickById = new Map(picks.map((p) => [p.id, p]));

    for (const a of pickAssets) {
      if (seenPicks.has(a.draftPickId)) {
        issues.push({ severity: "error", message: "The same pick appears twice in this trade." });
      }
      seenPicks.add(a.draftPickId);

      const pick = pickById.get(a.draftPickId);
      if (!pick) {
        issues.push({ severity: "error", message: `Unknown draft pick ${a.draftPickId}.` });
        continue;
      }

      // League rule: no trading picks beyond next season. Scaffolding already
      // stops those picks existing, but a backfilled or hand-built payload
      // could still reference one, so the rule is checked rather than assumed.
      if (opts.currentYear !== undefined && pick.season.year > opts.currentYear + 1) {
        issues.push({
          severity: "error",
          message: `${pick.season.year} picks cannot be traded — the league only allows trading the current and next season (${opts.currentYear} and ${opts.currentYear + 1}).`,
        });
      }
      if (pick.currentOwnerTeamId !== a.fromTeamId) {
        const holder = teamById.get(pick.currentOwnerTeamId)?.abbrev ?? "another team";
        const sender = teamById.get(a.fromTeamId)?.abbrev ?? "that team";
        issues.push({
          severity: "error",
          message: `${sender} does not own the ${pick.season.year} round-${pick.round} pick — ${holder} does.`,
        });
      }
      if (pick.forfeited) {
        issues.push({
          severity: "error",
          message: `The ${pick.season.year} round-${pick.round} pick has been forfeited.`,
        });
      }
    }
  }

  // Slot swaps are strictly two-team exchanges.
  for (const a of assets) {
    if (a.kind === "draft_slot_swap" && a.fromTeamId === a.toTeamId) {
      issues.push({ severity: "error", message: "A slot swap needs two different teams." });
    }
  }

  const swapSeasons = assets.filter((a) => a.kind === "draft_slot_swap").map((a) => a.seasonId);
  if (new Set(swapSeasons).size !== swapSeasons.length) {
    issues.push({
      severity: "warning",
      message: "This trade swaps draft slots twice in the same season; they apply in order.",
    });
  }

  return issues;
}
