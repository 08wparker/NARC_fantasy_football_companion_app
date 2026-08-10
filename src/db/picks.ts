import { and, eq } from "drizzle-orm";

import * as schema from "./schema";
import type { DbOrTx } from "./types";

/**
 * How many future seasons of picks exist to be traded.
 *
 * ESPN itself supports no future-year pick trading at all, so this limit is
 * purely ours. Three years is the practical ceiling for keeper-league pick talk
 * and stops the pick table filling with noise nobody will ever trade.
 */
export const FUTURE_SEASON_HORIZON = 3;

export function maxScaffoldableYear(currentYear: number) {
  return currentYear + FUTURE_SEASON_HORIZON;
}

/**
 * Idempotently ensure a season exists with a full draft order and pick set.
 *
 * Deliberately on-demand rather than a one-shot seed script: a seed script rots
 * the moment someone wants to trade a pick one year further out. Safe to call
 * repeatedly — every write is an upsert or a no-op.
 *
 * Never deletes picks when draftRounds shrinks; picks already referenced by a
 * confirmed trade must survive. Shrinking is handled by marking `forfeited`
 * instead, which is a commissioner action, not a scaffold side effect.
 */
export async function ensureSeasonScaffold(
  db: DbOrTx,
  opts: {
    leagueId: number;
    year: number;
    currentYear: number;
    draftRounds?: number;
    baseKeeperSlots?: number;
    isSnakeDraft?: boolean;
    /** Position order for a brand-new season, as team ids. Defaults to team id order. */
    baseOrder?: number[];
  },
) {
  const { leagueId, year, currentYear } = opts;

  if (year > maxScaffoldableYear(currentYear)) {
    throw new Error(
      `Refusing to scaffold ${year}: beyond the ${FUTURE_SEASON_HORIZON}-year horizon (max ${maxScaffoldableYear(currentYear)}).`,
    );
  }

  const teams = await db.query.teams.findMany({
    where: eq(schema.teams.leagueId, leagueId),
    orderBy: (t, { asc }) => [asc(t.espnTeamId)],
  });
  if (teams.length === 0) {
    throw new Error(`Cannot scaffold ${year}: league ${leagueId} has no teams yet.`);
  }

  // Inherit rules from the most recent prior season unless overridden.
  const prior = await db.query.seasons.findFirst({
    where: eq(schema.seasons.leagueId, leagueId),
    orderBy: (s, { desc }) => [desc(s.year)],
  });

  const draftRounds = opts.draftRounds ?? prior?.draftRounds ?? 16;
  const baseKeeperSlots = opts.baseKeeperSlots ?? prior?.baseKeeperSlots ?? 3;
  const isSnakeDraft = opts.isSnakeDraft ?? prior?.isSnakeDraft ?? true;

  await db
    .insert(schema.seasons)
    .values({ leagueId, year, draftRounds, baseKeeperSlots, isSnakeDraft })
    .onConflictDoNothing({ target: [schema.seasons.leagueId, schema.seasons.year] });

  const season = await db.query.seasons.findFirst({
    where: and(eq(schema.seasons.leagueId, leagueId), eq(schema.seasons.year, year)),
  });
  if (!season) throw new Error(`Season ${year} missing immediately after upsert.`);

  // Draft order. Only seeded when absent — never reset, because slot swaps
  // live in current_team_id and a reset would silently undo them.
  const existingOrder = await db.query.draftOrder.findMany({
    where: eq(schema.draftOrder.seasonId, season.id),
  });
  if (existingOrder.length === 0) {
    const ordered = opts.baseOrder
      ? opts.baseOrder.map((id) => {
          const t = teams.find((team) => team.id === id);
          if (!t) throw new Error(`baseOrder references unknown team id ${id}`);
          return t;
        })
      : teams;

    await db.insert(schema.draftOrder).values(
      ordered.map((t, i) => ({
        seasonId: season.id,
        position: i + 1,
        baseTeamId: t.id,
        currentTeamId: t.id,
      })),
    );
  }

  // Picks: one per (team, round). onConflictDoNothing makes added rounds a
  // pure addition and re-runs a no-op.
  await db
    .insert(schema.draftPicks)
    .values(
      teams.flatMap((t) =>
        Array.from({ length: draftRounds }, (_, r) => ({
          seasonId: season.id,
          round: r + 1,
          originalTeamId: t.id,
          currentOwnerTeamId: t.id,
        })),
      ),
    )
    .onConflictDoNothing({
      target: [
        schema.draftPicks.seasonId,
        schema.draftPicks.round,
        schema.draftPicks.originalTeamId,
      ],
    });

  return season;
}

/** Scaffold the whole rolling window: current season through the horizon. */
export async function ensureRollingWindow(
  db: DbOrTx,
  opts: { leagueId: number; currentYear: number },
) {
  const seasons = [];
  for (let year = opts.currentYear; year <= maxScaffoldableYear(opts.currentYear); year++) {
    seasons.push(await ensureSeasonScaffold(db, { ...opts, year }));
  }
  return seasons;
}
