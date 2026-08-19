import { describe, expect, it } from "vitest";

import type { TeamRoster } from "@/db/queries";
import type { DraftRecap } from "@/lib/espn/draft";
import { buildKeeperRosters, priceRosterPlayer, draftPicksByPlayer } from "@/lib/rosters";

/**
 * The fixture is deliberately awkward: a 1st-rounder (ineligible), a player
 * traded across teams after being drafted, a waiver add nobody drafted, and a
 * hand-entered player with no ESPN id. Those are the four shapes a real NARC
 * roster contains in August.
 */

function player(over: Partial<TeamRoster["players"][number]> = {}) {
  return {
    playerId: 1,
    espnPlayerId: 100,
    fullName: "Ja'Marr Chase",
    position: "WR",
    acquisitionType: "DRAFT",
    ...over,
  };
}

const recap: DraftRecap = {
  year: 2025,
  drafted: true,
  completeDate: 1724000000000,
  pickCount: 3,
  keeperCount: 1,
  roundCount: 9,
  teams: [
    {
      espnTeamId: 1,
      abbrev: "SACK",
      name: "Malik My Balls",
      picks: [
        {
          overall: 1,
          round: 1,
          roundPick: 1,
          espnTeamId: 1,
          playerId: 100,
          playerName: "Ja'Marr Chase",
          position: "WR",
          keeper: false,
          keeperRound: null,
        },
        {
          overall: 14,
          round: 2,
          roundPick: 2,
          espnTeamId: 1,
          playerId: 300,
          playerName: "Bijan Robinson",
          position: "RB",
          keeper: true,
          keeperRound: null,
        },
      ],
    },
    {
      espnTeamId: 2,
      abbrev: "WFP",
      name: "Sloppy saquons",
      picks: [
        {
          overall: 80,
          round: 7,
          roundPick: 8,
          espnTeamId: 2,
          playerId: 200,
          playerName: "Jauan Jennings",
          position: "WR",
          keeper: false,
          keeperRound: 4,
        },
      ],
    },
  ],
};

const picks = draftPicksByPlayer(recap);

describe("priceRosterPlayer", () => {
  it("charges three rounds better than where the player went", () => {
    const priced = priceRosterPlayer(player({ espnPlayerId: 200 }), picks);
    expect(priced.draftedRound).toBe(7);
    expect(priced.draftedPickInRound).toBe(8);
    expect(priced.cost).toEqual({ kind: "round", round: 4, undrafted: false });
  });

  it("marks a first-rounder ineligible rather than pricing him at 1", () => {
    const priced = priceRosterPlayer(player({ espnPlayerId: 100 }), picks);
    expect(priced.cost).toEqual({ kind: "ineligible", previousRound: 1 });
  });

  it("prices a player absent from the recap as undrafted", () => {
    const priced = priceRosterPlayer(player({ espnPlayerId: 999 }), picks);
    expect(priced.draftedRound).toBeNull();
    expect(priced.cost).toEqual({ kind: "round", round: 12, undrafted: true });
  });

  it("escalates from the round a keeper OCCUPIED, not where he was first drafted", () => {
    const priced = priceRosterPlayer(player({ espnPlayerId: 300 }), picks);
    expect(priced.wasKept).toBe(true);
    // Kept in the 2nd, so there is no cheaper round left to charge.
    expect(priced.cost).toEqual({ kind: "ineligible", previousRound: 2 });
  });

  it("keeps the drafting team, which is how a traded player carries his price", () => {
    const priced = priceRosterPlayer(player({ espnPlayerId: 200 }), picks);
    expect(priced.draftedByEspnTeamId).toBe(2);
  });

  it("is unknown, not undrafted, when there is no recap at all", () => {
    // ESPN down must never read as a ruling that everyone costs a 12th.
    const priced = priceRosterPlayer(player({ espnPlayerId: 200 }), null);
    expect(priced.cost).toEqual({ kind: "unknown" });
  });

  it("is unknown for a hand-entered player with no ESPN id", () => {
    const priced = priceRosterPlayer(player({ espnPlayerId: null }), picks);
    expect(priced.cost).toEqual({ kind: "unknown" });
  });
});

describe("buildKeeperRosters", () => {
  const rosters: TeamRoster[] = [
    {
      teamId: 7,
      espnTeamId: 2,
      abbrev: "WFP",
      name: "Sloppy saquons",
      players: [
        player({ playerId: 1, espnPlayerId: 999, fullName: "Waiver Guy", acquisitionType: "ADD" }),
        player({ playerId: 2, espnPlayerId: 200, fullName: "Jauan Jennings" }),
        player({ playerId: 3, espnPlayerId: 100, fullName: "Ja'Marr Chase" }),
      ],
    },
    { teamId: 8, espnTeamId: 3, abbrev: "HULL", name: "Hull", players: [] },
  ];

  it("orders each roster by the round the player occupied, undrafted last", () => {
    const [wfp] = buildKeeperRosters(rosters, recap);
    expect(wfp.players.map((p) => p.fullName)).toEqual([
      "Ja'Marr Chase", // 1.01 — ineligible, but the most expensive player there
      "Jauan Jennings", // 7.08
      "Waiver Guy", // undrafted
    ]);
  });

  it("counts only the players who may actually be kept", () => {
    const [wfp] = buildKeeperRosters(rosters, recap);
    // Jennings (4th) and the waiver add (12th); Chase cannot be kept.
    expect(wfp.keepableCount).toBe(2);
  });

  it("keeps an empty team in the list", () => {
    const built = buildKeeperRosters(rosters, recap);
    expect(built).toHaveLength(2);
    expect(built[1].players).toEqual([]);
    expect(built[1].keepableCount).toBe(0);
  });

  it("counts nothing as keepable when the draft could not be read", () => {
    const [wfp] = buildKeeperRosters(rosters, null);
    expect(wfp.keepableCount).toBe(0);
    expect(wfp.players.every((p) => p.cost.kind === "unknown")).toBe(true);
  });
});
