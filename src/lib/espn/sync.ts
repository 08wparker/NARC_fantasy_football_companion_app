import { and, eq } from "drizzle-orm";

import { ensureSeasonScaffold } from "@/db/picks";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";

import {
  EspnAuthError,
  isDormant,
  type EspnCredentials,
  type EspnLeagueResponse,
  fetchLeague,
} from "./client";
import { POSITION_BY_ID } from "./positions";

export type SyncCounts = {
  members: number;
  teams: number;
  teamSeasons: number;
  players: number;
  rosterSpots: number;
};

export type SyncResult = {
  status: "success" | "partial" | "failed";
  dormant: boolean;
  counts: SyncCounts;
  error?: string;
};

/**
 * Mirror one ESPN season into the database.
 *
 * Three rules that keep a dormant season from destroying the mirror:
 *
 *  1. UPSERT ONLY, NEVER DELETE. An empty payload from an inactive season means
 *     "no information", not "these things no longer exist".
 *  2. Record fields are only written when standings are actually available.
 *     They are nullable with no default, so a dormant year reads as NULL → "—",
 *     never as a real 0-0.
 *  3. Team identity (id, abbrev, name, owners) IS written even when dormant —
 *     that is the part the trade ledger needs, and ESPN provides it regardless.
 *
 * This function never touches draft_picks ownership or draft_order.current —
 * those are derived from our own ledger, and ESPN has no idea about them.
 */
export async function syncSeason(
  db: Db,
  opts: {
    leagueId: number;
    espnLeagueId: string;
    year: number;
    currentYear: number;
    credentials: EspnCredentials | null;
  },
): Promise<SyncResult> {
  const counts: SyncCounts = {
    members: 0,
    teams: 0,
    teamSeasons: 0,
    players: 0,
    rosterSpots: 0,
  };

  const [run] = await db
    .insert(schema.syncRuns)
    .values({ leagueId: opts.leagueId, year: opts.year, status: "failed" })
    .returning();

  const finish = async (result: SyncResult) => {
    await db
      .update(schema.syncRuns)
      .set({
        status: result.status,
        finishedAt: new Date(),
        counts: result.counts as unknown as Record<string, number>,
        error: result.error ?? null,
      })
      .where(eq(schema.syncRuns.id, run.id));
    return result;
  };

  let payload: EspnLeagueResponse;
  try {
    payload = await fetchLeague({
      leagueId: opts.espnLeagueId,
      year: opts.year,
      credentials: opts.credentials,
    });
  } catch (error) {
    const message =
      error instanceof EspnAuthError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown ESPN error";
    return finish({ status: "failed", dormant: false, counts, error: message });
  }

  const dormant = isDormant(payload);
  const standingsAvailable = !dormant;

  // Season row. Rules come from ESPN where it offers them.
  const keeperCount = payload.settings?.draftSettings?.keeperCount;
  const season = await ensureSeasonScaffold(db, {
    leagueId: opts.leagueId,
    year: opts.year,
    // A year ESPN actually reports exists by definition, so it must not trip
    // the future-pick horizon guard that protects the trade builder.
    currentYear: Math.max(opts.currentYear, opts.year),
    baseKeeperSlots: typeof keeperCount === "number" ? keeperCount : undefined,
  });

  await db
    .update(schema.seasons)
    .set({
      espnIsActive: !dormant,
      standingsAvailable,
      rostersAvailable: (payload.teams ?? []).some((t) => (t.roster?.entries?.length ?? 0) > 0),
      espnStatus: (payload.status ?? {}) as Record<string, unknown>,
      lastSyncedAt: new Date(),
    })
    .where(eq(schema.seasons.id, season.id));

  // ── members ────────────────────────────────────────────────────────────
  for (const member of payload.members ?? []) {
    await db
      .insert(schema.espnMembers)
      .values({
        leagueId: opts.leagueId,
        espnMemberId: member.id,
        displayName: member.displayName ?? null,
        firstName: member.firstName ?? null,
        lastName: member.lastName ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.espnMembers.leagueId, schema.espnMembers.espnMemberId],
        set: {
          displayName: member.displayName ?? null,
          firstName: member.firstName ?? null,
          lastName: member.lastName ?? null,
        },
      });
    counts.members++;
  }

  const memberRows = await db.query.espnMembers.findMany({
    where: eq(schema.espnMembers.leagueId, opts.leagueId),
  });
  const memberIdByEspnId = new Map(memberRows.map((m) => [m.espnMemberId, m.id]));

  // ── teams ──────────────────────────────────────────────────────────────
  for (const espnTeam of payload.teams ?? []) {
    const abbrev = espnTeam.abbrev?.trim();
    const name = espnTeam.name?.trim();
    const primaryMemberId = espnTeam.primaryOwner
      ? (memberIdByEspnId.get(espnTeam.primaryOwner) ?? null)
      : null;

    // Only overwrite with something real — a dormant payload sometimes omits
    // these, and we must not clobber good data with placeholders.
    const teamUpdates = {
      ...(abbrev ? { abbrev } : {}),
      ...(name ? { name } : {}),
      ...(espnTeam.logo ? { logoUrl: espnTeam.logo } : {}),
      ...(primaryMemberId ? { primaryEspnMemberId: primaryMemberId } : {}),
    };

    const insert = db.insert(schema.teams).values({
      leagueId: opts.leagueId,
      espnTeamId: espnTeam.id,
      abbrev: abbrev || `T${espnTeam.id}`,
      name: name || `Team ${espnTeam.id}`,
      logoUrl: espnTeam.logo ?? null,
      primaryEspnMemberId: primaryMemberId,
    });

    // An empty `set` is a Drizzle error, and "nothing worth updating" is a real
    // case here — a payload that omits every field must be a no-op, not a crash.
    await (Object.keys(teamUpdates).length > 0
      ? insert.onConflictDoUpdate({
          target: [schema.teams.leagueId, schema.teams.espnTeamId],
          set: teamUpdates,
        })
      : insert.onConflictDoNothing({
          target: [schema.teams.leagueId, schema.teams.espnTeamId],
        }));
    counts.teams++;
  }

  const teamRows = await db.query.teams.findMany({
    where: eq(schema.teams.leagueId, opts.leagueId),
  });
  const teamIdByEspnId = new Map(teamRows.map((t) => [t.espnTeamId, t.id]));

  // ── manager seats ──────────────────────────────────────────────────────
  // Created unclaimed (userId NULL). Never overwrites an existing claim.
  for (const espnTeam of payload.teams ?? []) {
    const teamId = teamIdByEspnId.get(espnTeam.id);
    if (!teamId) continue;

    const owners = espnTeam.owners ?? [];
    for (const [index, ownerGuid] of owners.entries()) {
      const espnMemberId = memberIdByEspnId.get(ownerGuid);
      if (!espnMemberId) continue;

      const existing = await db.query.teamManagers.findFirst({
        where: eq(schema.teamManagers.espnMemberId, espnMemberId),
      });
      if (existing) continue;

      await db.insert(schema.teamManagers).values({
        leagueId: opts.leagueId,
        teamId,
        espnMemberId,
        role: index === 0 ? "primary" : "co",
      });
    }
  }

  // ── per-season records ─────────────────────────────────────────────────
  for (const espnTeam of payload.teams ?? []) {
    const teamId = teamIdByEspnId.get(espnTeam.id);
    if (!teamId) continue;

    const overall = espnTeam.record?.overall;
    // Defence #2: only write record fields when standings really exist.
    const recordFields = standingsAvailable
      ? {
          wins: overall?.wins ?? null,
          losses: overall?.losses ?? null,
          ties: overall?.ties ?? null,
          pointsFor: overall?.pointsFor != null ? Math.round(overall.pointsFor) : null,
          pointsAgainst:
            overall?.pointsAgainst != null ? Math.round(overall.pointsAgainst) : null,
          finalRank: espnTeam.rankCalculatedFinal ?? null,
        }
      : {};

    const seasonUpdates = {
      ...(espnTeam.name ? { name: espnTeam.name } : {}),
      ...(espnTeam.abbrev ? { abbrev: espnTeam.abbrev } : {}),
      ...recordFields,
    };

    const insertSeasonRow = db.insert(schema.teamSeasons).values({
      seasonId: season.id,
      teamId,
      name: espnTeam.name ?? null,
      abbrev: espnTeam.abbrev ?? null,
      ...recordFields,
    });

    await (Object.keys(seasonUpdates).length > 0
      ? insertSeasonRow.onConflictDoUpdate({
          target: [schema.teamSeasons.seasonId, schema.teamSeasons.teamId],
          set: seasonUpdates,
        })
      : insertSeasonRow.onConflictDoNothing({
          target: [schema.teamSeasons.seasonId, schema.teamSeasons.teamId],
        }));
    counts.teamSeasons++;
  }

  // ── rosters ────────────────────────────────────────────────────────────
  for (const espnTeam of payload.teams ?? []) {
    const teamId = teamIdByEspnId.get(espnTeam.id);
    if (!teamId) continue;

    for (const entry of espnTeam.roster?.entries ?? []) {
      const player = entry.playerPoolEntry?.player;
      const espnPlayerId = player?.id ?? entry.playerId;
      if (!espnPlayerId) continue;

      await db
        .insert(schema.players)
        .values({
          espnPlayerId,
          fullName: player?.fullName ?? `Player ${espnPlayerId}`,
          defaultPosition:
            player?.defaultPositionId != null
              ? (POSITION_BY_ID[player.defaultPositionId] ?? null)
              : null,
          lastSyncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.players.espnPlayerId,
          set: {
            ...(player?.fullName ? { fullName: player.fullName } : {}),
            lastSyncedAt: new Date(),
          },
        });
      counts.players++;

      const playerRow = await db.query.players.findFirst({
        where: eq(schema.players.espnPlayerId, espnPlayerId),
      });
      if (!playerRow) continue;

      await db
        .insert(schema.rosterSpots)
        .values({
          seasonId: season.id,
          teamId,
          playerId: playerRow.id,
          acquisitionType: entry.acquisitionType ?? null,
        })
        .onConflictDoUpdate({
          target: [
            schema.rosterSpots.seasonId,
            schema.rosterSpots.teamId,
            schema.rosterSpots.playerId,
          ],
          set: { acquisitionType: entry.acquisitionType ?? null, syncedAt: new Date() },
        });
      counts.rosterSpots++;
    }
  }

  return finish({ status: "success", dormant, counts });
}

/** Sync the current season plus any prior seasons ESPN reports. */
export async function syncLeague(
  db: Db,
  opts: {
    leagueId: number;
    espnLeagueId: string;
    currentYear: number;
    credentials: EspnCredentials | null;
    years?: number[];
  },
) {
  const years = opts.years ?? [opts.currentYear];
  const results: Array<{ year: number; result: SyncResult }> = [];

  for (const year of years) {
    results.push({
      year,
      result: await syncSeason(db, {
        leagueId: opts.leagueId,
        espnLeagueId: opts.espnLeagueId,
        year,
        currentYear: opts.currentYear,
        credentials: opts.credentials,
      }),
    });
  }

  return results;
}

/** Has the most recent sync failed on credentials? Drives the re-paste banner. */
export async function credentialsLookStale(db: Db, leagueId: number) {
  const latest = await db.query.syncRuns.findFirst({
    where: and(eq(schema.syncRuns.leagueId, leagueId), eq(schema.syncRuns.status, "failed")),
    orderBy: (r, { desc }) => [desc(r.startedAt)],
  });
  return Boolean(latest?.error?.includes("401") || latest?.error?.includes("expired"));
}
