import { and, eq } from "drizzle-orm";

import { rebuildDerivedState, type DerivationWarning } from "./derive";
import * as schema from "./schema";
import {
  affectedSeasonIds,
  participantsOf,
  validateTradeAssets,
  type TradeAssetInput,
} from "./trade-logic";
import type { Db } from "./types";

export class TradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradeError";
  }
}

type Actor = {
  userId: number;
  teamIds: number[];
  isCommissioner: boolean;
};

/**
 * The trade state machine.
 *
 * Rules that hold everywhere in here:
 *  - `trade_assets` rows are written once and never updated. Corrections are
 *    status transitions, so the original record survives an argument in August.
 *  - Every transition writes a `trade_events` row.
 *  - Every transition that changes what is "confirmed" rebuilds derived state
 *    for the affected seasons *in the same transaction*, so the cache can never
 *    disagree with the ledger.
 */

async function assetsOf(db: Db, tradeId: number) {
  return db.query.tradeAssets.findMany({ where: eq(schema.tradeAssets.tradeId, tradeId) });
}

async function rebuildAffected(
  tx: Db,
  assets: Array<{ kind: string; draftPickId: number | null; seasonId: number | null }>,
) {
  const seasonIds = await affectedSeasonIds(tx, assets);
  const warnings: DerivationWarning[] = [];
  for (const seasonId of seasonIds) {
    const result = await rebuildDerivedState(tx, seasonId);
    warnings.push(...result.warnings);
  }
  return warnings;
}

export async function createTrade(
  db: Db,
  actor: Actor,
  input: {
    leagueId: number;
    loggedByTeamId: number;
    assets: TradeAssetInput[];
    agreedOn?: Date | null;
    note?: string | null;
    currentYear?: number;
    /**
     * Commissioner-only: record a trade that already happened as immediately
     * confirmed, rather than sending it to the counterparty for approval.
     *
     * This is how last season's trades get into the ledger. The two-step
     * confirmation exists to stop one manager unilaterally asserting a trade —
     * it is meaningless for a trade everyone already played out months ago, and
     * chasing eleven people for retroactive approval would mean the historical
     * record simply never gets entered.
     */
    backfill?: boolean;
  },
) {
  if (!actor.teamIds.includes(input.loggedByTeamId) && !actor.isCommissioner) {
    throw new TradeError("You can only log trades for a franchise you manage.");
  }

  const participants = participantsOf(input.assets);
  if (!participants.includes(input.loggedByTeamId) && !actor.isCommissioner) {
    throw new TradeError("You must be a party to a trade to log it.");
  }

  if (input.backfill && !actor.isCommissioner) {
    throw new TradeError("Only the commissioner can record a trade as already agreed.");
  }
  if (input.backfill && !input.agreedOn) {
    throw new TradeError("A backfilled trade needs the date it was originally agreed.");
  }

  const issues = await validateTradeAssets(db, input.leagueId, input.assets, {
    currentYear: input.currentYear,
  });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new TradeError(errors.map((e) => e.message).join(" "));
  }

  return db.transaction(async (tx) => {
    const now = new Date();
    const [trade] = await tx
      .insert(schema.trades)
      .values({
        leagueId: input.leagueId,
        status: input.backfill ? "confirmed" : "pending",
        loggedByUserId: actor.userId,
        loggedByTeamId: input.loggedByTeamId,
        agreedOn: input.agreedOn ?? null,
        note: input.note ?? null,
        ...(input.backfill
          ? {
              confirmedAt: input.agreedOn ?? now,
              confirmedByUserId: actor.userId,
              confirmedByCommissioner: true,
            }
          : {}),
      })
      .returning();

    const assetRows = await tx
      .insert(schema.tradeAssets)
      .values(
        input.assets.map((a) => ({
          tradeId: trade.id,
          kind: a.kind,
          fromTeamId: a.fromTeamId,
          toTeamId: a.toTeamId,
          draftPickId: "draftPickId" in a ? a.draftPickId : null,
          playerId: "playerId" in a ? a.playerId : null,
          seasonId: "seasonId" in a ? a.seasonId : null,
          slotCount: "slotCount" in a ? a.slotCount : null,
          note: a.note ?? null,
        })),
      )
      .returning();

    await tx.insert(schema.tradeEvents).values({
      tradeId: trade.id,
      action: "created",
      toStatus: input.backfill ? "confirmed" : "pending",
      actorUserId: actor.userId,
      actorTeamId: input.loggedByTeamId,
      actedAsCommissioner:
        Boolean(input.backfill) ||
        (actor.isCommissioner && !actor.teamIds.includes(input.loggedByTeamId)),
      note: input.backfill
        ? `Backfilled by the commissioner as already agreed.${input.note ? ` ${input.note}` : ""}`
        : (input.note ?? null),
      snapshot: assetRows,
    });

    const warnings = issues.filter((i) => i.severity === "warning").map((w) => ({
      kind: "pick_not_owned_by_sender" as const,
      message: w.message,
    }));

    if (input.backfill) {
      // A backfilled trade is confirmed on arrival, so derived state moves now.
      const derived = await rebuildAffected(tx as unknown as Db, assetRows);
      return { trade, assets: assetRows, warnings: [...warnings, ...derived] };
    }

    // Pending trades change nothing derived — no rebuild here on purpose.
    return { trade, assets: assetRows, warnings };
  });
}

/**
 * Confirm a pending trade.
 *
 * The confirmer must be a party who did NOT log it — that's the whole point of
 * the two-step flow — or the commissioner acting as a referee.
 */
export async function confirmTrade(db: Db, actor: Actor, tradeId: number) {
  const trade = await db.query.trades.findFirst({ where: eq(schema.trades.id, tradeId) });
  if (!trade) throw new TradeError("Trade not found.");
  if (trade.status !== "pending") {
    throw new TradeError(`Only a pending trade can be confirmed (this one is ${trade.status}).`);
  }

  const assets = await assetsOf(db, tradeId);
  const participants = participantsOf(assets as unknown as TradeAssetInput[]);

  const actingTeamId = actor.teamIds.find(
    (id) => participants.includes(id) && id !== trade.loggedByTeamId,
  );

  if (!actingTeamId && !actor.isCommissioner) {
    throw new TradeError(
      "Only the counterparty can confirm this trade. Ask the commissioner if they are unavailable.",
    );
  }

  return db.transaction(async (tx) => {
    const confirmedAt = new Date();
    await tx
      .update(schema.trades)
      .set({
        status: "confirmed",
        confirmedAt,
        confirmedByUserId: actor.userId,
        confirmedByTeamId: actingTeamId ?? null,
        confirmedByCommissioner: !actingTeamId,
      })
      .where(eq(schema.trades.id, tradeId));

    await tx.insert(schema.tradeEvents).values({
      tradeId,
      action: "confirmed",
      fromStatus: "pending",
      toStatus: "confirmed",
      actorUserId: actor.userId,
      actorTeamId: actingTeamId ?? null,
      actedAsCommissioner: !actingTeamId,
      snapshot: assets,
    });

    const warnings = await rebuildAffected(tx as unknown as Db, assets);
    return { warnings };
  });
}

/** Counterparty declines. */
export async function rejectTrade(db: Db, actor: Actor, tradeId: number, note?: string) {
  const trade = await db.query.trades.findFirst({ where: eq(schema.trades.id, tradeId) });
  if (!trade) throw new TradeError("Trade not found.");
  if (trade.status !== "pending") {
    throw new TradeError(`Only a pending trade can be rejected (this one is ${trade.status}).`);
  }

  const assets = await assetsOf(db, tradeId);
  const participants = participantsOf(assets as unknown as TradeAssetInput[]);
  const actingTeamId = actor.teamIds.find(
    (id) => participants.includes(id) && id !== trade.loggedByTeamId,
  );
  if (!actingTeamId && !actor.isCommissioner) {
    throw new TradeError("Only the counterparty or the commissioner can reject this trade.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.trades)
      .set({ status: "rejected", resolvedAt: new Date(), resolvedByUserId: actor.userId })
      .where(eq(schema.trades.id, tradeId));

    await tx.insert(schema.tradeEvents).values({
      tradeId,
      action: "rejected",
      fromStatus: "pending",
      toStatus: "rejected",
      actorUserId: actor.userId,
      actorTeamId: actingTeamId ?? null,
      actedAsCommissioner: !actingTeamId,
      note: note ?? null,
    });
  });
}

/** The proposer withdraws before anyone confirmed. */
export async function cancelTrade(db: Db, actor: Actor, tradeId: number, note?: string) {
  const trade = await db.query.trades.findFirst({ where: eq(schema.trades.id, tradeId) });
  if (!trade) throw new TradeError("Trade not found.");
  if (trade.status !== "pending") {
    throw new TradeError(`Only a pending trade can be cancelled (this one is ${trade.status}).`);
  }
  if (!actor.teamIds.includes(trade.loggedByTeamId) && !actor.isCommissioner) {
    throw new TradeError("Only the team that logged this trade can cancel it.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.trades)
      .set({ status: "cancelled", resolvedAt: new Date(), resolvedByUserId: actor.userId })
      .where(eq(schema.trades.id, tradeId));

    await tx.insert(schema.tradeEvents).values({
      tradeId,
      action: "cancelled",
      fromStatus: "pending",
      toStatus: "cancelled",
      actorUserId: actor.userId,
      actorTeamId: trade.loggedByTeamId,
      note: note ?? null,
    });
  });
}

/**
 * Commissioner reverses an already-confirmed trade.
 *
 * This is the ONLY way to undo a confirmed trade — there is deliberately no
 * edit path. The void and its reason stay visible forever, and the rebuild
 * recomputes ownership from scratch rather than trying to "unapply" the trade,
 * so the undo can never drift from the do.
 */
export async function voidTrade(db: Db, actor: Actor, tradeId: number, reason: string) {
  if (!actor.isCommissioner) {
    throw new TradeError("Only the commissioner can void a confirmed trade.");
  }
  if (!reason?.trim()) {
    throw new TradeError("Voiding a confirmed trade requires a reason.");
  }

  const trade = await db.query.trades.findFirst({ where: eq(schema.trades.id, tradeId) });
  if (!trade) throw new TradeError("Trade not found.");
  if (trade.status !== "confirmed") {
    throw new TradeError(`Only a confirmed trade can be voided (this one is ${trade.status}).`);
  }

  const assets = await assetsOf(db, tradeId);

  return db.transaction(async (tx) => {
    await tx
      .update(schema.trades)
      .set({ status: "voided", resolvedAt: new Date(), resolvedByUserId: actor.userId })
      .where(eq(schema.trades.id, tradeId));

    await tx.insert(schema.tradeEvents).values({
      tradeId,
      action: "voided",
      fromStatus: "confirmed",
      toStatus: "voided",
      actorUserId: actor.userId,
      actedAsCommissioner: true,
      note: reason,
      snapshot: assets,
    });

    const warnings = await rebuildAffected(tx as unknown as Db, assets);
    return { warnings };
  });
}

/** Trades awaiting this actor's confirmation. */
export async function pendingForActor(db: Db, leagueId: number, actor: Actor) {
  const pending = await db.query.trades.findMany({
    where: and(eq(schema.trades.leagueId, leagueId), eq(schema.trades.status, "pending")),
    with: { assets: true },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });

  if (actor.isCommissioner) return pending;

  return pending.filter((t) => {
    if (actor.teamIds.includes(t.loggedByTeamId)) return false; // you logged it
    const participants = participantsOf(t.assets as unknown as TradeAssetInput[]);
    return actor.teamIds.some((id) => participants.includes(id));
  });
}
