"use server";

import { revalidatePath, updateTag } from "next/cache";

import { db } from "@/db";
import { requireLeagueMembership } from "@/lib/auth/membership";
import { credentialsFromEnv } from "@/lib/espn/client";
import { syncSeason } from "@/lib/espn/sync";
import { ESPN_LEAGUE_ID, currentSeasonYear, getLeague } from "@/lib/league";

export type RefreshRostersResult =
  | {
      ok: true;
      /** The season the rosters actually came from — see below. */
      year: number;
      dormant: boolean;
      teams: number;
      rosterSpots: number;
    }
  | { ok: false; error: string };

/**
 * Pull current rosters from ESPN on demand.
 *
 * Open to any manager, not just the commissioner, unlike `/api/sync`. A sync is
 * upsert-only against the mirror tables and never touches the ledger or the
 * derived state (see `syncSeason`), so the worst a manager can do with this is
 * make the mirror *more* current. During a draft everybody needs that, and
 * routing it through one person is the failure mode.
 *
 * The draft recap cache is expired too. Keeper prices on this page are read off
 * the last draft, so a refresh that left an hour-old recap in place would still
 * be showing yesterday's prices — `updateTag` (not `revalidateTag`) because the
 * re-render that follows this action must not be served the stale copy.
 */
export async function refreshRostersAction(): Promise<RefreshRostersResult> {
  try {
    // Re-authorized here: Server Functions are reachable directly and proxy.ts
    // does not cover them.
    await requireLeagueMembership();

    const credentials = credentialsFromEnv();
    if (!credentials) {
      throw new Error(
        "ESPN_S2 and ESPN_SWID are not set. NARC is a private league, so every ESPN " +
          "request 401s without them.",
      );
    }

    const league = await getLeague();
    const currentYear = currentSeasonYear();

    let year = currentYear;
    let result = await syncSeason(db, {
      leagueId: league.id,
      espnLeagueId: ESPN_LEAGUE_ID,
      year,
      currentYear,
      credentials,
    });

    /**
     * Fall back a year when the new season has no rosters yet.
     *
     * ESPN answers 200 for a season it has not reactivated, with no roster
     * entries at all. From February until reactivation, last season's rosters
     * ARE the current rosters — and they are exactly what the next draft's
     * keeper prices come off. Syncing only the current year would leave the
     * page empty for the half of the calendar when it matters most.
     */
    if (result.status === "success" && result.counts.rosterSpots === 0) {
      const previous = await syncSeason(db, {
        leagueId: league.id,
        espnLeagueId: ESPN_LEAGUE_ID,
        year: currentYear - 1,
        currentYear,
        credentials,
      });
      if (previous.status === "success" && previous.counts.rosterSpots > 0) {
        year = currentYear - 1;
        result = previous;
      }
    }

    if (result.status === "failed") throw new Error(result.error ?? "The ESPN sync failed.");

    updateTag("draft-recap");
    revalidatePath("/current-rosters");
    revalidatePath("/draft-results");

    return {
      ok: true,
      year,
      dormant: result.dormant,
      teams: result.counts.teams,
      rosterSpots: result.counts.rosterSpots,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
}
