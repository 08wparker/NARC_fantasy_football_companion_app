import { describe, expect, it } from "vitest";

import { UNDRAFTED_KEEPER_ROUND, isKeepable, keeperRound } from "./keepers";

describe("keeperRound", () => {
  it("charges three rounds better than where the player went", () => {
    // The commissioner's own example.
    expect(keeperRound(7)).toBe(4);
  });

  it("charges a 12th for an undrafted player", () => {
    expect(keeperRound(null)).toBe(UNDRAFTED_KEEPER_ROUND);
  });

  it("makes round 4 the deepest keepable pick", () => {
    expect(keeperRound(4)).toBe(1);
  });

  it("returns null for rounds 1-3, which cannot be kept", () => {
    expect(keeperRound(3)).toBeNull();
    expect(keeperRound(2)).toBeNull();
    expect(keeperRound(1)).toBeNull();
  });

  it("never silently floors an ineligible round to 1", () => {
    // Rendering a 2nd-rounder as a 1st-round keeper would invent a rule the
    // league did not vote for.
    expect(keeperRound(2)).not.toBe(1);
  });

  it("compounds — a kept player gets more expensive each year", () => {
    let round: number | null = 15;
    const ladder: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      round = keeperRound(round);
      ladder.push(round);
      if (round === null) break;
    }
    expect(ladder).toEqual([12, 9, 6, 3, null]);
  });

  it("prices a late-round find out after four seasons", () => {
    expect(keeperRound(keeperRound(keeperRound(15)))).toBe(6);
  });

  it("treats an undrafted player as a 12th, then escalates from there", () => {
    expect(keeperRound(keeperRound(null))).toBe(9);
  });
});

describe("isKeepable", () => {
  it("agrees with keeperRound", () => {
    expect(isKeepable(4)).toBe(true);
    expect(isKeepable(3)).toBe(false);
    expect(isKeepable(null)).toBe(true);
  });
});
