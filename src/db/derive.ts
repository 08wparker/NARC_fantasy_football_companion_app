import { and, asc, eq, inArray, sql } from "drizzle-orm";

import * as schema from "./schema";
import type { DbOrTx } from "./types";

export type DerivationWarning = {
  kind: "pick_not_owned_by_sender" | "slot_swap_team_not_in_order" | "keeper_slots_negative";
  tradeId?: number;
  tradeAssetId?: number;
  message: string;
};

/**
 * Recompute every derived column for a season from the confirmed ledger.
 *
 * Full rebuild, not incremental apply/unapply. It is only a few hundred rows,
 * and rebuilding means the "undo" path can never drift from the "do" path —
 * which is the usual way these systems rot. Chained trades (A→B, then B→C)
 * fall out for free from replaying in confirmation order.
 *
 * MUST run inside the same transaction as any trade status transition.
 */
export async function rebuildDerivedState(
  tx: DbOrTx,
  seasonId: number,
): Promise<{ warnings: DerivationWarning[] }> {
  const warnings: DerivationWarning[] = [];

  const orderRows = await tx.query.draftOrder.findMany({
    where: eq(schema.draftOrder.seasonId, seasonId),
    orderBy: (o, { asc: a }) => [a(o.position)],
  });

  const pickRows = await tx.query.draftPicks.findMany({
    where: eq(schema.draftPicks.seasonId, seasonId),
  });

  // ── replay state, starting from the un-traded baseline ───────────────────
  const pickOwner = new Map<number, number>(); // pickId -> teamId
  for (const p of pickRows) pickOwner.set(p.id, p.originalTeamId);

  const slotTeam = new Map<number, number>(); // position -> teamId
  for (const o of orderRows) slotTeam.set(o.position, o.baseTeamId);

  const pickById = new Map(pickRows.map((p) => [p.id, p]));
  const pickIds = pickRows.map((p) => p.id);

  // ── the confirmed ledger, in the order it was agreed ─────────────────────
  //
  // Two asset kinds move derived state: draft_pick transfers (scoped to picks
  // in this season) and draft_slot_swap (scoped by season_id directly).
  // keeper_right / keeper_slot / player have no materialized effect.
  const assets = await tx
    .select({
      assetId: schema.tradeAssets.id,
      tradeId: schema.tradeAssets.tradeId,
      kind: schema.tradeAssets.kind,
      fromTeamId: schema.tradeAssets.fromTeamId,
      toTeamId: schema.tradeAssets.toTeamId,
      draftPickId: schema.tradeAssets.draftPickId,
      assetSeasonId: schema.tradeAssets.seasonId,
      confirmedAt: schema.trades.confirmedAt,
    })
    .from(schema.tradeAssets)
    .innerJoin(schema.trades, eq(schema.trades.id, schema.tradeAssets.tradeId))
    .where(
      and(
        eq(schema.trades.status, "confirmed"),
        sql`(
          (${schema.tradeAssets.kind} = 'draft_pick'
            AND ${pickIds.length > 0 ? inArray(schema.tradeAssets.draftPickId, pickIds) : sql`false`})
          OR (${schema.tradeAssets.kind} = 'draft_slot_swap'
            AND ${schema.tradeAssets.seasonId} = ${seasonId})
        )`,
      ),
    )
    .orderBy(asc(schema.trades.confirmedAt), asc(schema.tradeAssets.id));

  for (const a of assets) {
    if (a.kind === "draft_pick") {
      const pick = a.draftPickId ? pickById.get(a.draftPickId) : undefined;
      if (!pick) continue; // belongs to another season

      const holder = pickOwner.get(pick.id);
      if (holder !== a.fromTeamId) {
        // Someone logged a trade of a pick they no longer held. We still apply
        // it (last confirmed trade wins, matching what the managers believe
        // they agreed) but surface it loudly — this is a ledger error a human
        // has to resolve, not something to paper over.
        warnings.push({
          kind: "pick_not_owned_by_sender",
          tradeId: a.tradeId,
          tradeAssetId: a.assetId,
          message: `Round ${pick.round} pick was held by team ${holder}, but trade ${a.tradeId} sends it from team ${a.fromTeamId}.`,
        });
      }
      pickOwner.set(pick.id, a.toTeamId);
      continue;
    }

    // draft_slot_swap: exchange the two teams' current board positions.
    const fromPos = [...slotTeam.entries()].find(([, t]) => t === a.fromTeamId)?.[0];
    const toPos = [...slotTeam.entries()].find(([, t]) => t === a.toTeamId)?.[0];
    if (fromPos === undefined || toPos === undefined) {
      warnings.push({
        kind: "slot_swap_team_not_in_order",
        tradeId: a.tradeId,
        tradeAssetId: a.assetId,
        message: `Slot swap in trade ${a.tradeId} references a team with no draft slot in this season.`,
      });
      continue;
    }
    slotTeam.set(fromPos, a.toTeamId);
    slotTeam.set(toPos, a.fromTeamId);
  }

  // ── write back ───────────────────────────────────────────────────────────
  const changedPicks = pickRows.filter((p) => pickOwner.get(p.id) !== p.currentOwnerTeamId);
  for (const p of changedPicks) {
    await tx
      .update(schema.draftPicks)
      .set({ currentOwnerTeamId: pickOwner.get(p.id)! })
      .where(eq(schema.draftPicks.id, p.id));
  }

  /**
   * draft_order is delete-then-insert rather than UPDATE.
   *
   * `draft_order_season_current_team_uq` is a plain unique index, which
   * Postgres enforces row-by-row *within* a statement. Resetting a swapped
   * pair with one UPDATE would transiently put two rows on the same team and
   * spuriously violate it. Deleting first sidesteps that entirely, and it is
   * 12 rows.
   */
  const orderChanged = orderRows.some((o) => slotTeam.get(o.position) !== o.currentTeamId);
  if (orderChanged) {
    await tx.delete(schema.draftOrder).where(eq(schema.draftOrder.seasonId, seasonId));
    await tx.insert(schema.draftOrder).values(
      orderRows.map((o) => ({
        seasonId: o.seasonId,
        position: o.position,
        baseTeamId: o.baseTeamId,
        currentTeamId: slotTeam.get(o.position)!,
      })),
    );
  }

  return { warnings };
}

/**
 * Keeper slots per team for a season: the league base, plus/minus confirmed
 * keeper_slot trades. Computed on read rather than materialized — nothing sorts
 * or joins on it, so a cached column would be pure liability.
 */
export async function keeperSlotsBySeason(tx: DbOrTx, seasonId: number) {
  const season = await tx.query.seasons.findFirst({
    where: eq(schema.seasons.id, seasonId),
  });
  if (!season) throw new Error(`Unknown season ${seasonId}`);

  const teams = await tx.query.teams.findMany({
    where: eq(schema.teams.leagueId, season.leagueId),
  });

  const moves = await tx
    .select({
      fromTeamId: schema.tradeAssets.fromTeamId,
      toTeamId: schema.tradeAssets.toTeamId,
      slotCount: schema.tradeAssets.slotCount,
    })
    .from(schema.tradeAssets)
    .innerJoin(schema.trades, eq(schema.trades.id, schema.tradeAssets.tradeId))
    .where(
      and(
        eq(schema.trades.status, "confirmed"),
        eq(schema.tradeAssets.kind, "keeper_slot"),
        eq(schema.tradeAssets.seasonId, seasonId),
      ),
    );

  const slots = new Map(teams.map((t) => [t.id, season.baseKeeperSlots]));
  for (const m of moves) {
    const n = m.slotCount ?? 0;
    slots.set(m.fromTeamId, (slots.get(m.fromTeamId) ?? 0) - n);
    slots.set(m.toTeamId, (slots.get(m.toTeamId) ?? 0) + n);
  }

  const warnings: DerivationWarning[] = [];
  for (const [teamId, count] of slots) {
    if (count < 0) {
      warnings.push({
        kind: "keeper_slots_negative",
        message: `Team ${teamId} has ${count} keeper slots for ${season.year} after confirmed trades.`,
      });
    }
  }

  return { slots, warnings };
}

/**
 * Keeper rights traded into/out of a team for a season, as (playerId, teamId).
 * Later confirmed trades of the same player's rights win.
 */
export async function keeperRightsBySeason(tx: DbOrTx, seasonId: number) {
  const rows = await tx
    .select({
      playerId: schema.tradeAssets.playerId,
      toTeamId: schema.tradeAssets.toTeamId,
    })
    .from(schema.tradeAssets)
    .innerJoin(schema.trades, eq(schema.trades.id, schema.tradeAssets.tradeId))
    .where(
      and(
        eq(schema.trades.status, "confirmed"),
        eq(schema.tradeAssets.kind, "keeper_right"),
        eq(schema.tradeAssets.seasonId, seasonId),
      ),
    )
    .orderBy(asc(schema.trades.confirmedAt), asc(schema.tradeAssets.id));

  const rights = new Map<number, number>();
  for (const r of rows) if (r.playerId) rights.set(r.playerId, r.toTeamId);
  return rights;
}
