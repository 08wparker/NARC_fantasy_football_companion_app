import { describe, expect, it } from "vitest";

import { keeperSurplus, looksPopulated, pickToRound } from "@/lib/adp";

describe("pickToRound", () => {
  it("puts the last pick of a round in that round, not the next one", () => {
    expect(pickToRound(1, 12)).toBe(1);
    expect(pickToRound(12, 12)).toBe(1);
    expect(pickToRound(13, 12)).toBe(2);
    expect(pickToRound(27.4, 12)).toBe(3); // a fractional ADP still lands in a round
  });

  it("is straight division, because a snake never moves a pick between rounds", () => {
    // Overall 13 is the first pick of round 2 whichever end it is taken from.
    expect(pickToRound(13, 12)).toBe(2);
    expect(pickToRound(24, 12)).toBe(2);
  });

  it("refuses nonsense rather than inventing a round", () => {
    expect(pickToRound(0, 12)).toBeNull();
    expect(pickToRound(-4, 12)).toBeNull();
    expect(pickToRound(Number.NaN, 12)).toBeNull();
    expect(pickToRound(10, 0)).toBeNull();
  });
});

describe("looksPopulated", () => {
  it("rejects ESPN's sentinel, which is one value repeated across the pool", () => {
    // Verified against the live API: every player comes back at 170.0 when
    // ESPN has no ADP to report.
    expect(looksPopulated(Array.from({ length: 50 }, () => 170))).toBe(false);
  });

  it("accepts a field that actually varies", () => {
    expect(looksPopulated(Array.from({ length: 50 }, (_, i) => i + 1))).toBe(true);
  });

  it("does not judge a sample too small to judge", () => {
    expect(looksPopulated([170, 170])).toBe(true);
    expect(looksPopulated([])).toBe(false);
  });
});

describe("keeperSurplus", () => {
  it("is positive when the keeper price is later than the market", () => {
    // Costs a 5th, goes in the 2nd: three rounds of profit.
    expect(keeperSurplus(5, 2)).toBe(3);
  });

  it("is negative when the draft is the cheaper way to get him", () => {
    expect(keeperSurplus(2, 5)).toBe(-3);
  });

  it("is null, never zero, when either side is unknown", () => {
    expect(keeperSurplus(null, 2)).toBeNull();
    expect(keeperSurplus(5, null)).toBeNull();
  });
});
