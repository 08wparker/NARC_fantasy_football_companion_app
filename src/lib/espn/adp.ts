/**
 * The draft market for a set of players, read live from ESPN and cached.
 *
 * Same shape of decision as the draft recap (`./draft.ts`): this is ESPN's
 * data about the outside world, it changes daily through the preseason, and
 * mirroring it would create a table whose only job is to go stale. So it is
 * fetched and cached, never written down.
 *
 * Fetched by explicit player id rather than by pulling ESPN's top-N board.
 * `filterIds` is the one call shape this app already proves works against a
 * private league (it is how the draft recap resolves names), and it bounds the
 * response to the players actually rostered instead of trusting ESPN's `limit`
 * and sort filters, which the season-wide endpoint ignores.
 */
import { unstable_cache } from "next/cache";

import { credentialsFromEnv, type EspnPlayerInfo, fetchPlayerInfo } from "./client";
import { type AdpBoard, type AdpEntry, looksPopulated } from "../adp";

/** ADP moves daily in August, so this is much shorter than a draft recap's. */
const ADP_TTL_SECONDS = 3600;

/** Cache tag, so a roster refresh can expire the market with it. */
export const ADP_CACHE_TAG = "player-adp";

/**
 * Bump when `AdpBoard`'s shape changes. Same reasoning as
 * `RECAP_SHAPE_VERSION`: the data cache outlives deployments, so without a
 * bump new code reads objects written by old code.
 */
const ADP_SHAPE_VERSION = "v1";

/**
 * Pure composition step, separated from I/O so the source choice is testable
 * without a network.
 */
export function buildAdpBoard(year: number, players: Map<number, EspnPlayerInfo>): AdpBoard {
  const rows = [...players.entries()];

  const measured = rows
    .map(([, info]) => info.averageDraftPosition)
    .filter((v): v is number => typeof v === "number" && v > 0);

  // Prefer the real ADP, but only when ESPN actually populated it.
  const useMeasured = looksPopulated(measured);

  const entries: AdpEntry[] = [];
  for (const [espnPlayerId, info] of rows) {
    const pick = useMeasured ? info.averageDraftPosition : info.pprRank;
    if (typeof pick === "number" && pick > 0) entries.push({ espnPlayerId, pick });
  }

  return {
    year,
    source: useMeasured ? "average-draft-position" : "ppr-rank",
    entries: entries.sort((a, b) => a.pick - b.pick),
  };
}

/** Uncached: one chunked player-info lookup. */
export async function loadAdpBoard(
  leagueId: string,
  year: number,
  espnPlayerIds: number[],
): Promise<AdpBoard> {
  if (espnPlayerIds.length === 0) return { year, source: "ppr-rank", entries: [] };

  const players = await fetchPlayerInfo({
    leagueId,
    year,
    playerIds: espnPlayerIds,
    credentials: credentialsFromEnv(),
  });

  return buildAdpBoard(year, players);
}

/**
 * Cached read for one set of players.
 *
 * The ids are part of the cache key, so a roster move re-fetches — which is
 * exactly when the market for that roster changed. They are sorted and joined
 * rather than hashed so a cache entry stays legible when debugging.
 */
export function getAdpBoard(
  leagueId: string,
  year: number,
  espnPlayerIds: number[],
): Promise<AdpBoard> {
  const ids = [...new Set(espnPlayerIds)].sort((a, b) => a - b);

  return unstable_cache(
    () => loadAdpBoard(leagueId, year, ids),
    ["player-adp", ADP_SHAPE_VERSION, leagueId, String(year), ids.join(",")],
    { revalidate: ADP_TTL_SECONDS, tags: [ADP_CACHE_TAG] },
  )();
}
