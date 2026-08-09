import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { NARC_TEAMS, seedLeague } from "@/db/seed";
import type { Db } from "@/db/types";
import { makeTestDb } from "@/test/db";

describe("seedLeague", () => {
  let db: Db;
  const opts = { espnLeagueId: "718396", currentYear: 2026 };

  beforeEach(async () => {
    ({ db } = await makeTestDb());
  });

  it("creates the league, 12 teams, and a 4-season rolling window", async () => {
    const { league, seasons } = await seedLeague(db, opts);

    expect(league.espnLeagueId).toBe("718396");
    const teams = await db.query.teams.findMany({ where: eq(schema.teams.leagueId, league.id) });
    expect(teams).toHaveLength(12);
    expect(teams.map((t) => t.abbrev).sort()).toEqual(
      [...NARC_TEAMS.map((t) => t.abbrev)].sort(),
    );

    // current year plus a 3-year horizon
    expect(seasons.map((s) => s.year)).toEqual([2026, 2027, 2028, 2029]);
  });

  it("scaffolds a full pick set per season", async () => {
    const { seasons } = await seedLeague(db, opts);
    for (const season of seasons) {
      const picks = await db.query.draftPicks.findMany({
        where: eq(schema.draftPicks.seasonId, season.id),
      });
      expect(picks).toHaveLength(12 * season.draftRounds);
      // nothing is traded yet
      expect(picks.every((p) => p.currentOwnerTeamId === p.originalTeamId)).toBe(true);
    }
  });

  it("gives every season a complete 12-slot draft order", async () => {
    const { seasons } = await seedLeague(db, opts);
    for (const season of seasons) {
      const order = await db.query.draftOrder.findMany({
        where: eq(schema.draftOrder.seasonId, season.id),
      });
      expect(order).toHaveLength(12);
      expect(order.map((o) => o.position).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      expect(order.every((o) => o.currentTeamId === o.baseTeamId)).toBe(true);
    }
  });

  it("creates two manager seats for the co-managed BUES franchise", async () => {
    const { league } = await seedLeague(db, opts);
    const bues = await db.query.teams.findFirst({
      where: eq(schema.teams.abbrev, "BUES"),
    });
    const seats = await db.query.teamManagers.findMany({
      where: eq(schema.teamManagers.teamId, bues!.id),
    });

    expect(seats).toHaveLength(2);
    expect(seats.map((s) => s.displayNameOverride).sort()).toEqual([
      "Rob Buesing",
      "Robert Buesing",
    ]);
    expect(seats.filter((s) => s.role === "primary")).toHaveLength(1);
    // Nobody is linked to a Clerk account yet — that's what lets the
    // commissioner backfill the ledger before anyone signs up.
    expect(seats.every((s) => s.userId === null)).toBe(true);
    expect(league.teamCount).toBe(12);
  });

  it("marks exactly the intended commissioners", async () => {
    await seedLeague(db, opts);
    const commissioners = await db.query.teamManagers.findMany({
      where: eq(schema.teamManagers.leagueRole, "commissioner"),
      with: { team: true },
    });
    expect(commissioners.map((c) => c.team.abbrev).sort()).toEqual(["SACK", "WFP"]);
  });

  it("is idempotent — re-seeding changes nothing", async () => {
    await seedLeague(db, opts);
    const before = {
      teams: await db.query.teams.findMany(),
      seats: await db.query.teamManagers.findMany(),
      picks: await db.query.draftPicks.findMany(),
      order: await db.query.draftOrder.findMany(),
      seasons: await db.query.seasons.findMany(),
    };

    await seedLeague(db, opts);
    const after = {
      teams: await db.query.teams.findMany(),
      seats: await db.query.teamManagers.findMany(),
      picks: await db.query.draftPicks.findMany(),
      order: await db.query.draftOrder.findMany(),
      seasons: await db.query.seasons.findMany(),
    };

    expect(after.teams).toHaveLength(before.teams.length);
    expect(after.seats).toHaveLength(before.seats.length);
    expect(after.picks).toHaveLength(before.picks.length);
    expect(after.order).toHaveLength(before.order.length);
    expect(after.seasons).toHaveLength(before.seasons.length);
  });

  it("does not reset a slot swap when re-seeding", async () => {
    const { league, seasons } = await seedLeague(db, opts);
    const season = seasons[1];
    const order = await db.query.draftOrder.findMany({
      where: eq(schema.draftOrder.seasonId, season.id),
      orderBy: (o, { asc }) => [asc(o.position)],
    });

    // Simulate a confirmed swap having already moved teams around.
    await db.delete(schema.draftOrder).where(eq(schema.draftOrder.seasonId, season.id));
    await db.insert(schema.draftOrder).values(
      order.map((o, i) => ({
        seasonId: o.seasonId,
        position: o.position,
        baseTeamId: o.baseTeamId,
        currentTeamId: i === 0 ? order[1].baseTeamId : i === 1 ? order[0].baseTeamId : o.baseTeamId,
      })),
    );

    await seedLeague(db, { ...opts });

    const afterOrder = await db.query.draftOrder.findMany({
      where: eq(schema.draftOrder.seasonId, season.id),
      orderBy: (o, { asc }) => [asc(o.position)],
    });
    expect(afterOrder[0].currentTeamId).toBe(order[1].baseTeamId);
    expect(afterOrder[1].currentTeamId).toBe(order[0].baseTeamId);
    expect(league.id).toBeDefined();
  });
});
