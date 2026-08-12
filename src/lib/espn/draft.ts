/**
 * Draft recap — what a past draft actually produced.
 *
 * Distinct from the draft *board* (`src/db/queries.ts:draftBoard`), which is the
 * ledger of who owns which future slot. This is history, and history lives at
 * ESPN: a completed draft is immutable, there is nothing for the ledger to
 * disagree with, and mirroring it would be a table we could only ever copy into.
 * So it is fetched live and cached.
 *
 * Two calls, because ESPN splits them: the league document carries the picks
 * (mDraftDetail) and the team names (mTeam), but picks reference players only
 * by id, and a 2025 draft is full of players nobody rosters now.
 */
import { unstable_cache } from "next/cache";

import {
  credentialsFromEnv,
  type EspnLeagueResponse,
  type EspnPlayerInfo,
  fetchLeague,
  fetchPlayerInfo,
} from "./client";
import { positionName } from "./positions";

export type DraftPickRow = {
  overall: number;
  round: number;
  roundPick: number;
  espnTeamId: number;
  playerId: number;
  playerName: string | null;
  position: string | null;
  keeper: boolean;
};

export type DraftTeamGroup = {
  espnTeamId: number;
  abbrev: string;
  name: string;
  picks: DraftPickRow[];
};

export type DraftRecap = {
  year: number;
  drafted: boolean;
  completeDate: number | null;
  availableYears: number[];
  teams: DraftTeamGroup[];
  pickCount: number;
  keeperCount: number;
  roundCount: number;
};

/** How long a recap stays cached. A finished draft never changes; this is only
 *  short enough that the *current* season's draft appears the day it happens. */
const RECAP_TTL_SECONDS = 3600;

function teamLabel(team: { abbrev?: string; name?: string; id: number }) {
  const name = team.name?.trim();
  const abbrev = team.abbrev?.trim();
  return {
    name: name || abbrev || `Team ${team.id}`,
    abbrev: abbrev || name?.slice(0, 4).toUpperCase() || String(team.id),
  };
}

/**
 * Pure composition step, separated from I/O so it can be tested without a
 * network or a cookie.
 */
export function buildDraftRecap(
  year: number,
  response: EspnLeagueResponse,
  players: Map<number, EspnPlayerInfo>,
): DraftRecap {
  const detail = response.draftDetail;
  const picks = detail?.picks ?? [];

  const rows: DraftPickRow[] = picks
    .map((p) => {
      const info = players.get(p.playerId);
      return {
        overall: p.overallPickNumber,
        round: p.roundId,
        roundPick: p.roundPickNumber,
        espnTeamId: p.teamId,
        playerId: p.playerId,
        // Null, not "undefined" or the raw id — the UI renders an em dash.
        playerName: info?.fullName ?? null,
        position: positionName(info?.defaultPositionId),
        keeper: p.keeper === true,
      };
    })
    .sort((a, b) => a.overall - b.overall);

  // Group by ESPN team. Teams come from mTeam; a pick whose team is missing from
  // that list (a franchise that later left the league) still gets a group rather
  // than vanishing from the recap.
  const groups = new Map<number, DraftTeamGroup>();
  for (const team of response.teams ?? []) {
    const { name, abbrev } = teamLabel(team);
    groups.set(team.id, { espnTeamId: team.id, abbrev, name, picks: [] });
  }
  for (const row of rows) {
    let group = groups.get(row.espnTeamId);
    if (!group) {
      group = {
        espnTeamId: row.espnTeamId,
        abbrev: String(row.espnTeamId),
        name: `Team ${row.espnTeamId}`,
        picks: [],
      };
      groups.set(row.espnTeamId, group);
    }
    group.picks.push(row);
  }

  const teams = [...groups.values()]
    .filter((g) => g.picks.length > 0)
    .sort((a, b) => a.espnTeamId - b.espnTeamId);

  return {
    year,
    drafted: detail?.drafted === true && rows.length > 0,
    completeDate: detail?.completeDate ?? null,
    availableYears: [
      ...new Set([...(response.status?.previousSeasons ?? []), year]),
    ].sort((a, b) => b - a),
    teams,
    pickCount: rows.length,
    keeperCount: rows.filter((r) => r.keeper).length,
    roundCount: rows.reduce((max, r) => Math.max(max, r.round), 0),
  };
}

/** Uncached: one league document plus the player-name lookups it implies. */
export async function loadDraftRecap(leagueId: string, year: number): Promise<DraftRecap> {
  const credentials = credentialsFromEnv();

  const response = await fetchLeague({
    leagueId,
    year,
    credentials,
    views: ["mDraftDetail", "mTeam"],
  });

  const playerIds = (response.draftDetail?.picks ?? []).map((p) => p.playerId);
  const players =
    playerIds.length > 0
      ? await fetchPlayerInfo({ leagueId, year, playerIds, credentials })
      : new Map<number, EspnPlayerInfo>();

  return buildDraftRecap(year, response, players);
}

/**
 * Cached read. Keyed on league + year so the season switcher does not refetch a
 * season already viewed this hour.
 */
export function getDraftRecap(leagueId: string, year: number): Promise<DraftRecap> {
  return unstable_cache(
    () => loadDraftRecap(leagueId, year),
    ["draft-recap", leagueId, String(year)],
    { revalidate: RECAP_TTL_SECONDS, tags: ["draft-recap"] },
  )();
}
