import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { seedLeague } from "@/db/seed";
import type { Db } from "@/db/types";
import { makeTestDb } from "@/test/db";

// Mocked so the suite never touches the network.
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, fetchLeague: vi.fn() };
});

import { EspnAuthError, fetchLeague, isDormant } from "./client";
import { syncSeason } from "./sync";

const mockFetchLeague = vi.mocked(fetchLeague);

/** An active season: real records, activatedDate present. */
function activePayload() {
  return {
    seasonId: 2025,
    status: {
      isActive: true,
      activatedDate: 1755402557651,
      previousSeasons: [2023, 2024],
    },
    settings: { name: "NARC", size: 12, draftSettings: { keeperCount: 2 } },
    members: [
      { id: "{AAA}", displayName: "sacksm", firstName: "Michael", lastName: "Sacks" },
      { id: "{BBB}", displayName: "wfp", firstName: "William", lastName: "Parker" },
    ],
    teams: [
      {
        id: 1,
        abbrev: "SACK",
        name: "Malik My Balls",
        owners: ["{AAA}"],
        primaryOwner: "{AAA}",
        record: { overall: { wins: 9, losses: 5, ties: 0, pointsFor: 1650.4, pointsAgainst: 1500.2 } },
        rankCalculatedFinal: 3,
        roster: {
          entries: [
            {
              playerId: 4366031,
              acquisitionType: "DRAFT",
              playerPoolEntry: {
                player: { id: 4366031, fullName: "Bijan Robinson", defaultPositionId: 2 },
              },
            },
          ],
        },
      },
      {
        id: 3,
        abbrev: "WFP",
        name: "Sloppy saquons at Zayffoni's",
        owners: ["{BBB}"],
        primaryOwner: "{BBB}",
        record: { overall: { wins: 7, losses: 7, ties: 0, pointsFor: 1500, pointsAgainst: 1520 } },
        roster: { entries: [] },
      },
    ],
  };
}

/**
 * The dormant 2026 payload, matching what ESPN actually returns: HTTP 200,
 * isActive false, no activatedDate, teams present with zeroed records.
 */
function dormantPayload() {
  return {
    seasonId: 2026,
    status: {
      isActive: false,
      latestScoringPeriod: 0,
      teamsJoined: 12,
      previousSeasons: [2023, 2024, 2025],
    },
    settings: { name: "NARC", size: 12 },
    members: [{ id: "{AAA}", displayName: "sacksm" }],
    teams: [
      {
        id: 1,
        abbrev: "SACK",
        name: "Malik My Balls",
        owners: ["{AAA}"],
        primaryOwner: "{AAA}",
        record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 } },
        roster: { entries: [] },
      },
    ],
  };
}

describe("isDormant", () => {
  it("treats isActive:false as dormant", () => {
    expect(isDormant(dormantPayload())).toBe(true);
  });

  it("treats a missing activatedDate as dormant", () => {
    expect(isDormant({ status: { isActive: true } })).toBe(true);
  });

  it("treats an activated season as live", () => {
    expect(isDormant(activePayload())).toBe(false);
  });
});

describe("syncSeason", () => {
  let db: Db;
  let leagueId: number;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    const { league } = await seedLeague(db, { espnLeagueId: "718396", currentYear: 2026 });
    leagueId = league.id;
    mockFetchLeague.mockReset();
  });

  const run = (year: number) =>
    syncSeason(db, {
      leagueId,
      espnLeagueId: "718396",
      year,
      currentYear: 2026,
      credentials: { espnS2: "x", swid: "{y}" },
    });

  it("writes records for an active season", async () => {
    mockFetchLeague.mockResolvedValue(activePayload());
    const result = await run(2025);

    expect(result.status).toBe("success");
    expect(result.dormant).toBe(false);

    const season = await db.query.seasons.findFirst({
      where: and(eq(schema.seasons.leagueId, leagueId), eq(schema.seasons.year, 2025)),
    });
    expect(season!.espnIsActive).toBe(true);
    expect(season!.standingsAvailable).toBe(true);

    const sack = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, "SACK") });
    const ts = await db.query.teamSeasons.findFirst({
      where: and(
        eq(schema.teamSeasons.seasonId, season!.id),
        eq(schema.teamSeasons.teamId, sack!.id),
      ),
    });
    expect(ts!.wins).toBe(9);
    expect(ts!.losses).toBe(5);
    expect(ts!.pointsFor).toBe(1650);
  });

  it("records NULL rather than 0-0 for a dormant season", async () => {
    mockFetchLeague.mockResolvedValue(dormantPayload());
    const result = await run(2026);

    expect(result.dormant).toBe(true);
    expect(result.status).toBe("success");

    const season = await db.query.seasons.findFirst({
      where: and(eq(schema.seasons.leagueId, leagueId), eq(schema.seasons.year, 2026)),
    });
    expect(season!.espnIsActive).toBe(false);
    expect(season!.standingsAvailable).toBe(false);

    const sack = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, "SACK") });
    const ts = await db.query.teamSeasons.findFirst({
      where: and(
        eq(schema.teamSeasons.seasonId, season!.id),
        eq(schema.teamSeasons.teamId, sack!.id),
      ),
    });
    // The whole point: not 0, which would render as a real 0-0 record.
    expect(ts!.wins).toBeNull();
    expect(ts!.losses).toBeNull();
    expect(ts!.pointsFor).toBeNull();
  });

  it("still writes team identity when dormant, because the ledger needs it", async () => {
    mockFetchLeague.mockResolvedValue(dormantPayload());
    await run(2026);

    const sack = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, "SACK") });
    expect(sack!.name).toBe("Malik My Balls");
    expect(sack!.primaryEspnMemberId).not.toBeNull();
  });

  it("a later dormant sync does not wipe data from an active one", async () => {
    mockFetchLeague.mockResolvedValue(activePayload());
    await run(2025);

    const active = await db.query.seasons.findFirst({
      where: and(eq(schema.seasons.leagueId, leagueId), eq(schema.seasons.year, 2025)),
    });
    const rostersBefore = await db.query.rosterSpots.findMany({
      where: eq(schema.rosterSpots.seasonId, active!.id),
    });
    expect(rostersBefore).toHaveLength(1);

    // Now sync the dormant year, whose payload has empty rosters.
    mockFetchLeague.mockResolvedValue(dormantPayload());
    await run(2026);

    const rostersAfter = await db.query.rosterSpots.findMany({
      where: eq(schema.rosterSpots.seasonId, active!.id),
    });
    expect(rostersAfter).toHaveLength(1);

    const ts2025 = await db.query.teamSeasons.findMany({
      where: eq(schema.teamSeasons.seasonId, active!.id),
    });
    expect(ts2025.find((t) => t.wins === 9)).toBeDefined();
  });

  it("never clobbers a good team name with a placeholder", async () => {
    mockFetchLeague.mockResolvedValue(activePayload());
    await run(2025);

    // A payload that omits abbrev/name entirely.
    mockFetchLeague.mockResolvedValue({
      seasonId: 2026,
      status: { isActive: false },
      teams: [{ id: 1 }],
    });
    await run(2026);

    const sack = await db.query.teams.findFirst({ where: eq(schema.teams.espnTeamId, 1) });
    expect(sack!.abbrev).toBe("SACK");
    expect(sack!.name).toBe("Malik My Balls");
  });

  it("records a failed run with a re-paste hint when cookies expire", async () => {
    mockFetchLeague.mockRejectedValue(new EspnAuthError());
    const result = await run(2026);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/re-copy them/i);

    const runRow = await db.query.syncRuns.findFirst({
      where: eq(schema.syncRuns.leagueId, leagueId),
      orderBy: (r, { desc }) => [desc(r.startedAt)],
    });
    expect(runRow!.status).toBe("failed");
    expect(runRow!.error).toMatch(/espn_s2/i);
  });

  it("leaves the manual pick ledger completely untouched", async () => {
    const season2027 = await db.query.seasons.findFirst({
      where: and(eq(schema.seasons.leagueId, leagueId), eq(schema.seasons.year, 2027)),
    });
    const wfp = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, "WFP") });
    const sack = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, "SACK") });

    // Pretend a confirmed trade already moved a pick.
    const pick = await db.query.draftPicks.findFirst({
      where: and(
        eq(schema.draftPicks.seasonId, season2027!.id),
        eq(schema.draftPicks.originalTeamId, wfp!.id),
        eq(schema.draftPicks.round, 3),
      ),
    });
    await db
      .update(schema.draftPicks)
      .set({ currentOwnerTeamId: sack!.id })
      .where(eq(schema.draftPicks.id, pick!.id));

    mockFetchLeague.mockResolvedValue(activePayload());
    await run(2025);

    const after = await db.query.draftPicks.findFirst({
      where: eq(schema.draftPicks.id, pick!.id),
    });
    expect(after!.currentOwnerTeamId).toBe(sack!.id);
  });

  it("creates unclaimed manager seats without stealing an existing claim", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ clerkUserId: "u1", email: "a@b.c", displayName: "A" })
      .returning();
    const wfp = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, "WFP") });
    await db
      .update(schema.teamManagers)
      .set({ userId: user.id })
      .where(eq(schema.teamManagers.teamId, wfp!.id));

    mockFetchLeague.mockResolvedValue(activePayload());
    await run(2025);

    const seats = await db.query.teamManagers.findMany({
      where: eq(schema.teamManagers.teamId, wfp!.id),
    });
    expect(seats.some((s) => s.userId === user.id)).toBe(true);
  });
});
