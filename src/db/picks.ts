import { and, eq, gt, or } from "drizzle-orm";

import * as schema from "./schema";
import type { DbOrTx } from "./types";

/**
 * How many future seasons of picks exist to be traded.
 *
 * ONE, because the league rule is that you may not trade a pick beyond the next
 * season. This is not a technical limit — it is the rulebook expressed in the
 * schema, so a pick nobody is allowed to trade never gets created in the first
 * place and cannot show up in the trade builder by accident.
 */
export const FUTURE_SEASON_HORIZON = 1;

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

/**
 * Remove future seasons that sit beyond the horizon.
 *
 * Needed because the horizon shrank from three years to one: 2028 and 2029 were
 * already scaffolded under the old rule and would otherwise linger on the draft
 * board as years nobody is allowed to trade into.
 *
 * Refuses to touch a season any trade asset references, even a rejected or
 * cancelled one. Deleting a season cascades to its picks, which would orphan
 * `trade_assets.draft_pick_id` and silently rewrite history — exactly what the
 * immutable-ledger design exists to prevent. Returns what it skipped so the
 * caller can say so out loud.
 */
export async function pruneSeasonsBeyondHorizon(
  db: DbOrTx,
  opts: { leagueId: number; currentYear: number },
) {
  const cutoff = maxScaffoldableYear(opts.currentYear);

  const candidates = await db.query.seasons.findMany({
    where: and(eq(schema.seasons.leagueId, opts.leagueId), gt(schema.seasons.year, cutoff)),
  });

  const removed: number[] = [];
  const kept: Array<{ year: number; reason: string }> = [];

  for (const season of candidates) {
    const referencing = await db
      .select({ id: schema.tradeAssets.id })
      .from(schema.tradeAssets)
      .leftJoin(schema.draftPicks, eq(schema.draftPicks.id, schema.tradeAssets.draftPickId))
      .where(
        or(
          eq(schema.draftPicks.seasonId, season.id),
          eq(schema.tradeAssets.seasonId, season.id),
        ),
      )
      .limit(1);

    if (referencing.length > 0) {
      kept.push({ year: season.year, reason: "a trade references it" });
      continue;
    }

    await db.delete(schema.seasons).where(eq(schema.seasons.id, season.id));
    removed.push(season.year);
  }

  return { removed, kept, cutoff };
}
