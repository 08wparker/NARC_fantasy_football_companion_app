/**
 * Current rosters, priced for the next draft.
 *
 * The join that makes this page work: the roster comes from the ESPN mirror
 * (`roster_spots`), and the price comes from the last draft recap. Nothing new
 * is stored — a keeper price is a pure function of where the player last went,
 * so deriving it on read means it can never fall out of date with either side.
 *
 * Keeper rights follow the player, so the lookup is league-wide by ESPN player
 * id, not per team: a player drafted in the 7th by SACK and traded to WFP is a
 * 4th-round keeper *for WFP*. That is the same rule `validateTradeAssets`
 * encodes by refusing to let a keeper right move on its own.
 *
 * Kept pure (no db, no network) so the ordering and the edge cases —
 * ineligible, undrafted, ESPN unreachable — are testable directly.
 */
import type { RosterPlayer, TeamRoster } from "@/db/queries";
import { type AdpBoard, keeperSurplus, pickToRound } from "@/lib/adp";
import type { DraftPickRow, DraftRecap } from "@/lib/espn/draft";
import { UNDRAFTED_KEEPER_ROUND, keeperRound } from "@/lib/keepers";

/**
 * What a player costs to keep next season.
 *
 * Three cases, deliberately distinct in the type: a round he can be kept in,
 * a player nobody may keep, and a player we could not price because ESPN did
 * not answer. Collapsing the last two would tell the league that a player is
 * ineligible when the truth is that we don't know.
 */
export type KeeperCost =
  | { kind: "round"; round: number; undrafted: boolean }
  | { kind: "ineligible"; previousRound: number }
  | { kind: "unknown" };

export type KeeperRosterPlayer = RosterPlayer & {
  /** Round the player occupied in the last draft; null if he went undrafted. */
  draftedRound: number | null;
  draftedPickInRound: number | null;
  /** True when that pick was itself a keeper — the price has escalated before. */
  wasKept: boolean;
  /** Who drafted him. Differs from the roster team when he has been traded. */
  draftedByEspnTeamId: number | null;
  cost: KeeperCost;
  /** Where the market has him going, as an overall pick, and as a round. */
  adpPick: number | null;
  adpRound: number | null;
  /** Rounds the keeper price sits later than the market. Positive is a bargain. */
  surplus: number | null;
};

export type KeeperRoster = Omit<TeamRoster, "players"> & {
  players: KeeperRosterPlayer[];
  /** How many of them may actually be kept. */
  keepableCount: number;
  /** Keepable players whose price is later than where the market has them. */
  bargainCount: number;
};

/** Last draft indexed by player, so every roster can be priced in one pass. */
export function draftPicksByPlayer(recap: DraftRecap): Map<number, DraftPickRow> {
  const byPlayer = new Map<number, DraftPickRow>();
  for (const team of recap.teams) {
    for (const pick of team.picks) {
      // Later picks win, so a player ESPN somehow lists twice is priced off the
      // round he ended the draft in rather than the one he started it in.
      byPlayer.set(pick.playerId, pick);
    }
  }
  return byPlayer;
}

/**
 * Price one player.
 *
 * `null` picks means the recap could not be loaded at all — every player is
 * "unknown". A player who is simply absent from a recap we *do* have went
 * undrafted, which is a real price (a 12th), not a gap in the data.
 */
export function priceRosterPlayer(
  player: RosterPlayer,
  picks: Map<number, DraftPickRow> | null,
  market: { byPlayer: Map<number, number>; teamCount: number } | null = null,
): KeeperRosterPlayer {
  const adpPick =
    market && player.espnPlayerId !== null
      ? (market.byPlayer.get(player.espnPlayerId) ?? null)
      : null;
  const adpRound = adpPick !== null && market ? pickToRound(adpPick, market.teamCount) : null;

  const withMarket = (priced: Omit<KeeperRosterPlayer, "adpPick" | "adpRound" | "surplus">) => ({
    ...priced,
    adpPick,
    adpRound,
    // Only a real price has surplus to measure. "Ineligible" is not a round you
    // can compare against the market, and "unknown" is not a number at all.
    surplus: priced.cost.kind === "round" ? keeperSurplus(priced.cost.round, adpRound) : null,
  });

  const base = {
    ...player,
    draftedRound: null,
    draftedPickInRound: null,
    wasKept: false,
    draftedByEspnTeamId: null,
  };

  if (!picks) return withMarket({ ...base, cost: { kind: "unknown" } });

  // A player the commissioner typed in by hand has no ESPN id yet, so there is
  // nothing to look him up by. That is unknown, not undrafted.
  if (player.espnPlayerId === null) return withMarket({ ...base, cost: { kind: "unknown" } });

  const pick = picks.get(player.espnPlayerId);
  if (!pick) {
    return withMarket({
      ...base,
      cost: { kind: "round", round: UNDRAFTED_KEEPER_ROUND, undrafted: true },
    });
  }

  const round = keeperRound(pick.round);
  return withMarket({
    ...base,
    draftedRound: pick.round,
    draftedPickInRound: pick.roundPick,
    wasKept: pick.keeper,
    draftedByEspnTeamId: pick.espnTeamId,
    cost:
      round === null
        ? { kind: "ineligible", previousRound: pick.round }
        : { kind: "round", round, undrafted: false },
  });
}

/**
 * Rosters in draft-day reading order: the players who cost the most first.
 *
 * Sorting by the round the player *occupied* orders every case with one key —
 * a 1st-rounder (ineligible) above a 4th-rounder (a 1st-round keeper) above a
 * 15th — and puts the undrafted, who all cost the same 12th, at the bottom.
 */
export function buildKeeperRosters(
  rosters: TeamRoster[],
  recap: DraftRecap | null,
  adp: AdpBoard | null = null,
  teamCount = 12,
): KeeperRoster[] {
  const picks = recap ? draftPicksByPlayer(recap) : null;
  const market = adp
    ? { byPlayer: new Map(adp.entries.map((e) => [e.espnPlayerId, e.pick])), teamCount }
    : null;

  return rosters.map((roster) => {
    const players = roster.players
      .map((p) => priceRosterPlayer(p, picks, market))
      .sort(
        (a, b) =>
          (a.draftedRound ?? Number.POSITIVE_INFINITY) -
            (b.draftedRound ?? Number.POSITIVE_INFINITY) ||
          (a.draftedPickInRound ?? 0) - (b.draftedPickInRound ?? 0) ||
          a.fullName.localeCompare(b.fullName),
      );

    return {
      ...roster,
      players,
      keepableCount: players.filter((p) => p.cost.kind === "round").length,
      bargainCount: players.filter((p) => (p.surplus ?? 0) > 0).length,
    };
  });
}
