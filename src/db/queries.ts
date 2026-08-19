import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";

import * as schema from "./schema";
import type { DbOrTx } from "./types";

/* ─────────────────────────────── draft board ───────────────────────────── */

export type BoardPick = {
  pickId: number;
  round: number;
  slot: number;
  pickInRound: number;
  overall: number;
  originalTeam: { id: number; abbrev: string; name: string };
  currentOwner: { id: number; abbrev: string; name: string };
  isTraded: boolean;
};

/**
 * The draft board for a season, in overall pick order.
 *
 * The join that makes this work: a pick's board position comes from the
 * *original* team's current draft slot. That is what lets a slot swap move a
 * team's whole set of picks as a group while an individual pick trade only
 * changes its owner — the two compose without either knowing about the other.
 */
export async function draftBoard(db: DbOrTx, seasonId: number): Promise<BoardPick[]> {
  const season = await db.query.seasons.findFirst({
    where: eq(schema.seasons.id, seasonId),
    with: { league: true },
  });
  if (!season) throw new Error(`Unknown season ${seasonId}`);

  const teamCount = season.league.teamCount;

  const [order, picks, teams] = await Promise.all([
    db.query.draftOrder.findMany({ where: eq(schema.draftOrder.seasonId, seasonId) }),
    db.query.draftPicks.findMany({ where: eq(schema.draftPicks.seasonId, seasonId) }),
    db.query.teams.findMany({ where: eq(schema.teams.leagueId, season.leagueId) }),
  ]);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  // Which board slot each franchise currently occupies.
  const slotOf = new Map(order.map((o) => [o.currentTeamId, o.position]));

  const rows: BoardPick[] = [];
  for (const p of picks) {
    const slot = slotOf.get(p.originalTeamId);
    if (slot === undefined) continue; // team has no slot this season

    const pickInRound =
      season.isSnakeDraft && p.round % 2 === 0 ? teamCount + 1 - slot : slot;
    const overall = (p.round - 1) * teamCount + pickInRound;

    const originalTeam = teamById.get(p.originalTeamId)!;
    const currentOwner = teamById.get(p.currentOwnerTeamId)!;

    rows.push({
      pickId: p.id,
      round: p.round,
      slot,
      pickInRound,
      overall,
      originalTeam: {
        id: originalTeam.id,
        abbrev: originalTeam.abbrev,
        name: originalTeam.name,
      },
      currentOwner: {
        id: currentOwner.id,
        abbrev: currentOwner.abbrev,
        name: currentOwner.name,
      },
      isTraded: p.currentOwnerTeamId !== p.originalTeamId,
    });
  }

  return rows.sort((a, b) => a.overall - b.overall);
}

/* ───────────────────────────── provenance ──────────────────────────────── */

export type ProvenanceHop = {
  tradeId: number;
  at: Date | null;
  from: string;
  to: string;
};

/**
 * Where a pick has been. Needs no dedicated table — every trade_assets row
 * already carries from/to, so the chain is just those rows in confirmed order.
 */
export async function pickProvenance(db: DbOrTx, pickId: number): Promise<ProvenanceHop[]> {
  const rows = await db
    .select({
      tradeId: schema.trades.id,
      at: schema.trades.confirmedAt,
      fromTeamId: schema.tradeAssets.fromTeamId,
      toTeamId: schema.tradeAssets.toTeamId,
    })
    .from(schema.tradeAssets)
    .innerJoin(schema.trades, eq(schema.trades.id, schema.tradeAssets.tradeId))
    .where(
      and(eq(schema.tradeAssets.draftPickId, pickId), eq(schema.trades.status, "confirmed")),
    )
    .orderBy(schema.trades.confirmedAt, schema.tradeAssets.id);

  if (rows.length === 0) return [];

  const teamIds = [...new Set(rows.flatMap((r) => [r.fromTeamId, r.toTeamId]))];
  const teams = await db.query.teams.findMany({ where: inArray(schema.teams.id, teamIds) });
  const abbrev = new Map(teams.map((t) => [t.id, t.abbrev]));

  return rows.map((r) => ({
    tradeId: r.tradeId,
    at: r.at,
    from: abbrev.get(r.fromTeamId) ?? "?",
    to: abbrev.get(r.toTeamId) ?? "?",
  }));
}

/* ──────────────────────────── trade history ────────────────────────────── */

export async function tradeHistory(
  db: DbOrTx,
  leagueId: number,
  opts: { statuses?: Array<"pending" | "confirmed" | "rejected" | "cancelled" | "voided"> } = {},
) {
  const statuses = opts.statuses ?? ["confirmed", "voided"];
  return db.query.trades.findMany({
    where: and(
      eq(schema.trades.leagueId, leagueId),
      inArray(schema.trades.status, statuses),
    ),
    with: {
      assets: {
        with: {
          draftPick: { with: { season: true, originalTeam: true } },
          player: true,
          season: true,
          fromTeam: true,
          toTeam: true,
        },
      },
      events: { orderBy: (e, { asc }) => [asc(e.createdAt)] },
      loggedByTeam: true,
    },
    orderBy: [desc(schema.trades.confirmedAt), desc(schema.trades.createdAt)],
  });
}

export async function tradeDetail(db: DbOrTx, tradeId: number) {
  return db.query.trades.findFirst({
    where: eq(schema.trades.id, tradeId),
    with: {
      assets: {
        with: {
          draftPick: { with: { season: true, originalTeam: true } },
          player: true,
          season: true,
          fromTeam: true,
          toTeam: true,
        },
      },
      events: {
        with: { actorUser: true, actorTeam: true },
        orderBy: (e, { asc }) => [asc(e.createdAt)],
      },
      loggedByTeam: true,
      loggedByUser: true,
    },
  });
}

/* ───────────────────────────── my assets ───────────────────────────────── */

/** Every future pick a franchise currently holds, grouped by season. */
export async function picksOwnedByTeam(db: DbOrTx, teamId: number) {
  const picks = await db.query.draftPicks.findMany({
    where: eq(schema.draftPicks.currentOwnerTeamId, teamId),
    with: { season: true, originalTeam: true },
  });

  const bySeason = new Map<number, typeof picks>();
  for (const p of picks) {
    const list = bySeason.get(p.season.year) ?? [];
    list.push(p);
    bySeason.set(p.season.year, list);
  }

  return [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, list]) => ({
      year,
      picks: list.sort((a, b) => a.round - b.round),
    }));
}

/* ───────────────────────────── proposals ───────────────────────────────── */

export async function proposalsForLeague(db: DbOrTx, leagueId: number) {
  return db.query.proposals.findMany({
    where: eq(schema.proposals.leagueId, leagueId),
    with: {
      votes: { with: { team: true } },
      proposedByUser: true,
    },
    orderBy: [desc(schema.proposals.createdAt)],
  });
}

/* ───────────────────────── seasons & sync health ───────────────────────── */

export async function seasonsForLeague(db: DbOrTx, leagueId: number) {
  return db.query.seasons.findMany({
    where: eq(schema.seasons.leagueId, leagueId),
    orderBy: (s, { asc }) => [asc(s.year)],
  });
}

export async function latestSyncRun(db: DbOrTx, leagueId: number) {
  return db.query.syncRuns.findFirst({
    where: eq(schema.syncRuns.leagueId, leagueId),
    orderBy: (r, { desc: d }) => [d(r.startedAt)],
  });
}

/** Manager seats nobody has claimed yet — the commissioner's invite worklist. */
export async function unlinkedSeats(db: DbOrTx, leagueId: number) {
  const seats = await allSeats(db, leagueId);
  return seats.filter((s) => s.userId === null);
}

/**
 * Every seat, claimed or not, ordered the way the league page lists teams.
 * The commissioner needs to see claimed seats too — promoting Mike Sacks means
 * acting on a seat that is already occupied.
 */
export async function allSeats(db: DbOrTx, leagueId: number) {
  const seats = await db.query.teamManagers.findMany({
    where: eq(schema.teamManagers.leagueId, leagueId),
    with: { team: true, user: true },
  });
  return seats.sort(
    (a, b) => a.team.espnTeamId - b.team.espnTeamId || a.id - b.id,
  );
}

/** Everyone who has ever signed in — the pool for assigning an orphaned seat. */
export async function allUsers(db: DbOrTx) {
  return db.query.users.findMany({
    orderBy: (u, { asc }) => [asc(u.displayName)],
  });
}

/* ────────────────────────────── rosters ────────────────────────────────── */

export type RosterPlayer = {
  playerId: number;
  espnPlayerId: number | null;
  fullName: string;
  position: string | null;
  acquisitionType: string | null;
};

export type TeamRoster = {
  teamId: number;
  espnTeamId: number;
  abbrev: string;
  name: string;
  players: RosterPlayer[];
};

/**
 * Every franchise and who it *currently* rosters, out of the ESPN mirror.
 *
 * Two things this has to get right:
 *
 * **Dropped players.** The mirror is upsert-only and never deletes, so a player
 * waived in October still has his `roster_spots` row. Freshness is what
 * separates the roster from its history: every row the latest sync touched was
 * stamped `synced_at` after `seasons.last_synced_at` was written, so anything
 * older is somebody the team no longer holds. Filtering on read rather than
 * deleting keeps the mirror's never-delete rule intact — an empty payload from
 * a dormant season still cannot wipe anything out.
 *
 * **Empty teams.** All twelve come back whether or not they have players. A
 * team ESPN reported empty is information ("nobody rostered"), and dropping the
 * card would make the grid jump around between syncs.
 */
export async function rostersForSeason(db: DbOrTx, seasonId: number): Promise<TeamRoster[]> {
  const season = await db.query.seasons.findFirst({
    where: eq(schema.seasons.id, seasonId),
  });
  if (!season) throw new Error(`Unknown season ${seasonId}`);

  const currentRows = season.lastSyncedAt
    ? and(
        eq(schema.rosterSpots.seasonId, seasonId),
        gte(schema.rosterSpots.syncedAt, season.lastSyncedAt),
      )
    : // Never synced through this app (a hand-seeded season, or a test): there
      // is no run to be stale relative to, so every row still counts.
      eq(schema.rosterSpots.seasonId, seasonId);

  const [teams, spots] = await Promise.all([
    db.query.teams.findMany({ where: eq(schema.teams.leagueId, season.leagueId) }),
    db.query.rosterSpots.findMany({ where: currentRows, with: { player: true } }),
  ]);

  const byTeam = new Map<number, RosterPlayer[]>();
  for (const spot of spots) {
    const list = byTeam.get(spot.teamId) ?? [];
    list.push({
      playerId: spot.player.id,
      espnPlayerId: spot.player.espnPlayerId,
      fullName: spot.player.fullName,
      position: spot.player.defaultPosition,
      acquisitionType: spot.acquisitionType,
    });
    byTeam.set(spot.teamId, list);
  }

  return teams
    .sort((a, b) => a.espnTeamId - b.espnTeamId)
    .map((team) => ({
      teamId: team.id,
      espnTeamId: team.espnTeamId,
      abbrev: team.abbrev,
      name: team.name,
      players: byTeam.get(team.id) ?? [],
    }));
}

/**
 * The most recent season the mirror actually holds live rosters for.
 *
 * Not simply "the current season": ESPN returns a perfectly ordinary 200 for a
 * year it has not reactivated, with no roster entries at all. Between February
 * and the reactivation, last season's rosters ARE the current rosters — and
 * they are what the next draft's keeper prices are read off. Falling back to
 * the empty current season would show twelve empty cards all offseason, which
 * is exactly when this page matters most.
 *
 * "Holds rosters" uses the same freshness rule as `rostersForSeason`, so a
 * season whose rows are all left over from an older sync does not shadow an
 * older season that still has a real roster.
 */
export async function latestSeasonWithRosters(db: DbOrTx, leagueId: number) {
  const populated = await db
    .select({ seasonId: schema.rosterSpots.seasonId })
    .from(schema.rosterSpots)
    .innerJoin(schema.seasons, eq(schema.seasons.id, schema.rosterSpots.seasonId))
    .where(
      and(
        eq(schema.seasons.leagueId, leagueId),
        or(
          isNull(schema.seasons.lastSyncedAt),
          gte(schema.rosterSpots.syncedAt, schema.seasons.lastSyncedAt),
        ),
      ),
    )
    .groupBy(schema.rosterSpots.seasonId);

  if (populated.length === 0) return null;

  const ids = new Set(populated.map((r) => r.seasonId));
  const seasons = await seasonsForLeague(db, leagueId);
  // seasonsForLeague ascends by year, so the last match is the newest.
  return seasons.filter((s) => ids.has(s.id)).at(-1) ?? null;
}
