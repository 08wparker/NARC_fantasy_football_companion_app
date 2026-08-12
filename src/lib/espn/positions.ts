/**
 * ESPN's `defaultPositionId` decode ring.
 *
 * Shared by the sync (which persists the position on `players`) and the draft
 * recap (which renders it live). Kept in one place so the two can never
 * disagree about what a 16 is.
 */
export const POSITION_BY_ID: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "D/ST",
};

/** Undecodable ids are left null rather than guessed — ESPN adds positions. */
export function positionName(defaultPositionId: number | undefined | null) {
  if (defaultPositionId === undefined || defaultPositionId === null) return null;
  return POSITION_BY_ID[defaultPositionId] ?? null;
}
