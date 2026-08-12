/**
 * Keeper round escalation.
 *
 * League rule (rulebook #9): a keeper costs three rounds better than where the
 * player went in the previous draft. A 7th-round pick in 2025 is a 4th-round
 * keeper in 2026. Undrafted players cost a 12th.
 *
 * Two decisions the rule text leaves implicit, settled by the commissioner:
 *
 *  - **Rounds 1–3 cannot be kept at all.** `round - 3` is zero or negative and
 *    there is no round to charge, so elite talent goes back in the pool.
 *  - **It compounds.** The input is whatever round the player *occupied* last
 *    draft, whether he was drafted there or kept there. So a 9th-round keeper
 *    in 2025 is a 6th-round keeper in 2026, and gets more expensive every year
 *    until he prices himself out.
 */

/** Rounds better a keeper costs than where the player last went. */
export const KEEPER_ROUND_DISCOUNT = 3;

/** What an undrafted player costs to keep. */
export const UNDRAFTED_KEEPER_ROUND = 12;

/**
 * The round a player can be kept in next season.
 *
 * `null` means ineligible — there is no such round. Callers must render that
 * distinctly from "we don't know", which is why this never falls back to 1.
 *
 * @param previousRound the round the player occupied in the last draft, or
 *   `null` for a player who went undrafted.
 */
export function keeperRound(previousRound: number | null): number | null {
  if (previousRound === null) return UNDRAFTED_KEEPER_ROUND;
  const next = previousRound - KEEPER_ROUND_DISCOUNT;
  return next >= 1 ? next : null;
}

/** True when the player can be kept at all. */
export function isKeepable(previousRound: number | null): boolean {
  return keeperRound(previousRound) !== null;
}
