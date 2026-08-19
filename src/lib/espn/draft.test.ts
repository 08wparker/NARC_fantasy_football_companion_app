import { describe, expect, it } from "vitest";

import type { EspnLeagueResponse, EspnPlayerInfo } from "./client";
import { buildDraftRecap } from "./draft";

/**
 * These cover the composition step only — the network is not involved. The
 * fixture is deliberately lopsided (one team drafts out of order, one player
 * fails to resolve, one team is absent from mTeam) because those are the shapes
 * that actually come back from a five-year-old season.
 */

function response(overrides: Partial<EspnLeagueResponse> = {}): EspnLeagueResponse {
  return {
    seasonId: 2025,
    status: { previousSeasons: [2023, 2024] },
    teams: [
      { id: 1, abbrev: "SACK", name: "Malik My Balls" },
      { id: 2, abbrev: "WFP", name: "Sloppy saquons" },
    ],
    draftDetail: {
      drafted: true,
      completeDate: 1724000000000,
      picks: [
        { playerId: 100, teamId: 1, roundId: 1, roundPickNumber: 1, overallPickNumber: 1 },
        { playerId: 200, teamId: 2, roundId: 1, roundPickNumber: 2, overallPickNumber: 2 },
        {
          playerId: 300,
          teamId: 1,
          roundId: 2,
          roundPickNumber: 1,
          overallPickNumber: 3,
          keeper: true,
        },
      ],
    },
    ...overrides,
  } as EspnLeagueResponse;
}

const players = new Map<number, EspnPlayerInfo>([
  // The draft ranks are irrelevant to a recap — they are what the ADP board
  // reads off the same lookup — but the shape has to be whole.
  [100, { fullName: "Ja'Marr Chase", defaultPositionId: 3, pprRank: 1, averageDraftPosition: 1.2 }],
  [
    300,
    { fullName: "Bijan Robinson", defaultPositionId: 2, pprRank: 4, averageDraftPosition: 5.1 },
  ],
  // 200 deliberately absent — ESPN drops players from old seasons.
]);

describe("buildDraftRecap", () => {
  it("groups picks by team and counts the draft", () => {
    const recap = buildDraftRecap(2025, response(), players);

    expect(recap.drafted).toBe(true);
    expect(recap.pickCount).toBe(3);
    expect(recap.roundCount).toBe(2);
    expect(recap.keeperCount).toBe(1);
    expect(recap.teams.map((t) => t.abbrev)).toEqual(["SACK", "WFP"]);
    expect(recap.teams[0].picks.map((p) => p.overall)).toEqual([1, 3]);
  });

  it("resolves player names and positions", () => {
    const recap = buildDraftRecap(2025, response(), players);
    const first = recap.teams[0].picks[0];

    expect(first.playerName).toBe("Ja'Marr Chase");
    expect(first.position).toBe("WR");
    expect(first.keeper).toBe(false);
  });

  it("leaves an unresolved player null rather than rendering undefined", () => {
    const recap = buildDraftRecap(2025, response(), players);
    const orphan = recap.teams[1].picks[0];

    expect(orphan.playerName).toBeNull();
    expect(orphan.position).toBeNull();
    expect(orphan.playerId).toBe(200);
  });

  it("marks keeper picks", () => {
    const recap = buildDraftRecap(2025, response(), players);
    expect(recap.teams[0].picks[1]).toMatchObject({ keeper: true, playerName: "Bijan Robinson" });
  });

  it("sorts picks by overall number regardless of payload order", () => {
    const scrambled = response({
      draftDetail: {
        drafted: true,
        picks: [
          { playerId: 300, teamId: 1, roundId: 2, roundPickNumber: 1, overallPickNumber: 3 },
          { playerId: 100, teamId: 1, roundId: 1, roundPickNumber: 1, overallPickNumber: 1 },
        ],
      },
    } as Partial<EspnLeagueResponse>);

    expect(buildDraftRecap(2025, scrambled, players).teams[0].picks.map((p) => p.overall)).toEqual([
      1, 3,
    ]);
  });

  it("keeps picks whose team is missing from mTeam", () => {
    const orphaned = response({ teams: [{ id: 1, abbrev: "SACK", name: "Malik My Balls" }] });
    const recap = buildDraftRecap(2025, orphaned, players);

    expect(recap.pickCount).toBe(3);
    const unknown = recap.teams.find((t) => t.espnTeamId === 2);
    expect(unknown?.name).toBe("Team 2");
    expect(unknown?.picks).toHaveLength(1);
  });

  it("drops teams that drafted nobody", () => {
    const noPicks = response({
      draftDetail: {
        drafted: true,
        picks: [{ playerId: 100, teamId: 1, roundId: 1, roundPickNumber: 1, overallPickNumber: 1 }],
      },
    } as Partial<EspnLeagueResponse>);

    expect(buildDraftRecap(2025, noPicks, players).teams.map((t) => t.espnTeamId)).toEqual([1]);
  });

  it("reports an undrafted season as not drafted", () => {
    const upcoming = response({ draftDetail: { drafted: false, picks: [] } });
    const recap = buildDraftRecap(2026, upcoming, players);

    expect(recap.drafted).toBe(false);
    expect(recap.teams).toEqual([]);
    expect(recap.pickCount).toBe(0);
  });

  it("treats drafted:true with no picks as not drafted", () => {
    // ESPN reports this for a season it has reactivated but not yet populated;
    // rendering an empty grid under a 'drafted' banner would be a lie.
    const empty = response({ draftDetail: { drafted: true, picks: [] } });
    expect(buildDraftRecap(2026, empty, players).drafted).toBe(false);
  });

  it("attaches the next-season keeper round to every pick", () => {
    const recap = buildDraftRecap(2025, response(), players);

    // Round 1 and 2 are inside the top three, so there is no round to charge.
    expect(recap.teams[0].picks[0]).toMatchObject({ round: 1, keeperRound: null });
    expect(recap.teams[1].picks[0]).toMatchObject({ round: 1, keeperRound: null });
    expect(recap.teams[0].picks[1]).toMatchObject({ round: 2, keeperRound: null });
  });

  it("escalates a keepable round by three", () => {
    const deep = response({
      draftDetail: {
        drafted: true,
        picks: [
          { playerId: 100, teamId: 1, roundId: 7, roundPickNumber: 1, overallPickNumber: 73 },
          { playerId: 300, teamId: 1, roundId: 4, roundPickNumber: 1, overallPickNumber: 37 },
        ],
      },
    } as Partial<EspnLeagueResponse>);

    const picks = buildDraftRecap(2025, deep, players).teams[0].picks;
    expect(picks.map((p) => [p.round, p.keeperRound])).toEqual([
      [4, 1],
      [7, 4],
    ]);
  });
});
