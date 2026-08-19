import { describe, expect, it } from "vitest";

import type { EspnPlayerInfo } from "./client";
import { buildAdpBoard } from "./adp";

/**
 * The source choice is the whole point of this layer. ESPN publishes two
 * fields and only one of them is trustworthy at a time, so these cover both
 * shapes seen against the live API.
 */

function pool(
  entries: Array<[number, Partial<EspnPlayerInfo>]>,
): Map<number, EspnPlayerInfo> {
  return new Map(
    entries.map(([id, over]) => [
      id,
      { fullName: `Player ${id}`, pprRank: null, averageDraftPosition: null, ...over },
    ]),
  );
}

describe("buildAdpBoard", () => {
  it("prefers a real average draft position", () => {
    const board = buildAdpBoard(
      2026,
      pool([
        [1, { averageDraftPosition: 3.4, pprRank: 5 }],
        [2, { averageDraftPosition: 27.9, pprRank: 30 }],
        [3, { averageDraftPosition: 91.2, pprRank: 88 }],
        [4, { averageDraftPosition: 12.1, pprRank: 14 }],
        [5, { averageDraftPosition: 60.0, pprRank: 61 }],
      ]),
    );

    expect(board.source).toBe("average-draft-position");
    expect(board.entries.map((e) => e.pick)).toEqual([3.4, 12.1, 27.9, 60, 91.2]);
  });

  it("falls back to the PPR ranking when ADP is ESPN's flat sentinel", () => {
    // Verified live: every player reads 170.0 when ESPN has no ADP.
    const board = buildAdpBoard(
      2026,
      pool(
        Array.from({ length: 20 }, (_, i) => [
          i + 1,
          { averageDraftPosition: 170, pprRank: i + 1 },
        ]),
      ),
    );

    expect(board.source).toBe("ppr-rank");
    expect(board.entries).toHaveLength(20);
    expect(board.entries[0]).toEqual({ espnPlayerId: 1, pick: 1 });
  });

  it("leaves out a player ESPN ranks in no format at all", () => {
    const board = buildAdpBoard(
      2026,
      pool([
        [1, { pprRank: 12 }],
        [2, { pprRank: null }],
      ]),
    );

    expect(board.source).toBe("ppr-rank");
    expect(board.entries.map((e) => e.espnPlayerId)).toEqual([1]);
  });

  it("treats a zero as no data rather than the first overall pick", () => {
    const board = buildAdpBoard(2026, pool([[1, { pprRank: 0 }]]));
    expect(board.entries).toEqual([]);
  });

  it("returns a sorted board, so the caller never has to", () => {
    const board = buildAdpBoard(
      2026,
      pool([
        [1, { pprRank: 30 }],
        [2, { pprRank: 4 }],
        [3, { pprRank: 17 }],
      ]),
    );
    expect(board.entries.map((e) => e.pick)).toEqual([4, 17, 30]);
  });
});
