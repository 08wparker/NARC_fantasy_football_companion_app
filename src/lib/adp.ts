/**
 * Average draft position, expressed the way a keeper decision actually gets
 * made: as a round.
 *
 * A keeper price is a round ("he costs a 4th"). The market is a pick number
 * ("he goes 27th overall"). Those are not comparable until one is converted, so
 * this converts the market into rounds and hands the page a single subtraction:
 * a player who goes in round 2 and costs a 5th is three rounds of surplus, and
 * that number is the whole keep-or-not argument.
 *
 * Rounds here are straight division, NOT snake-aware. Overall pick 27 in a
 * 12-team league is round 3 whichever direction round 3 runs — the snake
 * changes who picks where inside a round, never which round a pick falls in.
 */

/**
 * Which ESPN field a board's numbers came from.
 *
 * ESPN offers two, and they are not equally trustworthy. `ownership
 * .averageDraftPosition` is a real measured ADP where it is populated, but the
 * season-wide endpoint returns a flat 170.0 for every player in the league —
 * verified, not assumed — so a board built from it would price the entire
 * league identically. `draftRanksByRankType.PPR.rank` is ESPN's own PPR
 * ranking: not a measured ADP, but always populated and explicitly the format
 * this league drafts. So: prefer the real thing, detect when it is a sentinel,
 * fall back to the ranking, and tell the UI which it got.
 */
export type AdpSource = "average-draft-position" | "ppr-rank";

/** One player's market position, as an overall pick number. */
export type AdpEntry = { espnPlayerId: number; pick: number };

/**
 * A whole board. Deliberately a plain array rather than a Map: this crosses
 * `unstable_cache`, which serializes, and a Map would come back empty.
 */
export type AdpBoard = { year: number; source: AdpSource; entries: AdpEntry[] };

/**
 * A field is only believable when it varies.
 *
 * ESPN reports `averageDraftPosition: 170.0` for every player when it has no
 * ADP to report, which is indistinguishable from a real value one player at a
 * time. Across a pool it is obvious: real ADPs are nearly all distinct, a
 * sentinel is one value repeated. Ten percent distinct is far below anything a
 * populated field produces and far above a sentinel's 1-of-N.
 */
export function looksPopulated(values: number[]): boolean {
  if (values.length < 5) return values.length > 0;
  return new Set(values).size >= values.length * 0.1;
}

/**
 * The round an overall pick falls in. 1-based, so pick 1 is round 1 and, in a
 * 12-team league, pick 12 is still round 1 while pick 13 opens round 2.
 */
export function pickToRound(pick: number, teamCount: number): number | null {
  if (!Number.isFinite(pick) || pick < 1 || teamCount < 1) return null;
  return Math.ceil(pick / teamCount);
}

/**
 * Rounds of surplus in keeping a player: how much later his keeper price is
 * than where the market says he goes.
 *
 * Positive is a bargain — costs a 5th, goes in the 2nd, three rounds ahead.
 * Negative means the draft is the cheaper way to get him. Null whenever either
 * side is unknown, because a missing number must never render as zero surplus.
 */
export function keeperSurplus(
  keeperRound: number | null,
  adpRound: number | null,
): number | null {
  if (keeperRound === null || adpRound === null) return null;
  return keeperRound - adpRound;
}
