import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureSeasonScaffold, pruneSeasonsBeyondHorizon } from "@/db/picks";
import { findOrCreatePlayerByName } from "@/db/player-service";
import * as schema from "@/db/schema";
import { seedLeague } from "@/db/seed";
import { createTrade } from "@/db/trade-service";
import type { Db } from "@/db/types";
import { makeTestDb } from "@/test/db";

/**
 * The four league rules that this app now enforces rather than merely documents.
 */
describe("league rules enforced by the ledger", () => {
  let db: Db;
  let leagueId: number;
  let team: Record<string, { id: number; abbrev: string }>;
  let commish: { userId: number; teamIds: number[]; isCommissioner: boolean };
  let member: typeof commish;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    const { league } = await seedLeague(db, { espnLeagueId: "718396", currentYear: 2026 });
    leagueId = league.id;

    const teams = await db.query.teams.findMany({ where: eq(schema.teams.leagueId, league.id) });
    team = Object.fromEntries(teams.map((t) => [t.abbrev, t]));

    const [user] = await db
      .insert(schema.users)
      .values({ clerkUserId: "u1", email: "a@b.c", displayName: "Tester" })
      .returning();
    commish = { userId: user.id, teamIds: [team.WFP.id], isCommissioner: true };
    member = { userId: user.id, teamIds: [team.WFP.id], isCommissioner: false };
  });

  const pickOf = async (abbrev: string, year: number, round: number) => {
    const season = await db.query.seasons.findFirst({ where: eq(schema.seasons.year, year) });
    if (!season) return undefined;
    return db.query.draftPicks.findFirst({
      where: (p, { and: a, eq: e }) =>
        a(e(p.seasonId, season.id), e(p.round, round), e(p.originalTeamId, team[abbrev].id)),
    });
  };

  describe("pick horizon: current + next season only", () => {
    it("scaffolds exactly two seasons", async () => {
      const seasons = await db.query.seasons.findMany({ orderBy: (s, { asc }) => [asc(s.year)] });
      expect(seasons.map((s) => s.year)).toEqual([2026, 2027]);
    });

    it("refuses to scaffold beyond the horizon", async () => {
      await expect(
        ensureSeasonScaffold(db, { leagueId, year: 2028, currentYear: 2026 }),
      ).rejects.toThrow(/beyond the 1-year horizon/i);
    });

    it("rejects a trade of a pick beyond next season", async () => {
      // Force a 2028 season into existence the way the old horizon would have.
      const [season] = await db
        .insert(schema.seasons)
        .values({ leagueId, year: 2028, draftRounds: 2 })
        .returning();
      const [farPick] = await db
        .insert(schema.draftPicks)
        .values({
          seasonId: season.id,
          round: 1,
          originalTeamId: team.WFP.id,
          currentOwnerTeamId: team.WFP.id,
        })
        .returning();

      await expect(
        createTrade(db, member, {
          leagueId,
          loggedByTeamId: team.WFP.id,
          currentYear: 2026,
          assets: [
            {
              kind: "draft_pick",
              fromTeamId: team.WFP.id,
              toTeamId: team.SACK.id,
              draftPickId: farPick.id,
            },
          ],
        }),
      ).rejects.toThrow(/2028 picks cannot be traded/i);
    });

    it("still allows current and next season picks", async () => {
      for (const year of [2026, 2027]) {
        const pick = await pickOf("WFP", year, 1);
        const { trade } = await createTrade(db, member, {
          leagueId,
          loggedByTeamId: team.WFP.id,
          currentYear: 2026,
          assets: [
            {
              kind: "draft_pick",
              fromTeamId: team.WFP.id,
              toTeamId: team.SACK.id,
              draftPickId: pick!.id,
            },
          ],
        });
        expect(trade.status).toBe("pending");
      }
    });
  });

  describe("pruning seasons beyond the horizon", () => {
    it("removes an untouched out-of-range season", async () => {
      await db.insert(schema.seasons).values({ leagueId, year: 2029, draftRounds: 1 });
      const result = await pruneSeasonsBeyondHorizon(db, { leagueId, currentYear: 2026 });
      expect(result.removed).toContain(2029);
      const left = await db.query.seasons.findMany();
      expect(left.map((s) => s.year).sort()).toEqual([2026, 2027]);
    });

    it("refuses to remove a season a trade references", async () => {
      const [season] = await db
        .insert(schema.seasons)
        .values({ leagueId, year: 2029, draftRounds: 1 })
        .returning();

      const [trade] = await db
        .insert(schema.trades)
        .values({ leagueId, loggedByUserId: commish.userId, loggedByTeamId: team.WFP.id })
        .returning();
      await db.insert(schema.tradeAssets).values({
        tradeId: trade.id,
        kind: "draft_slot_swap",
        fromTeamId: team.WFP.id,
        toTeamId: team.SACK.id,
        seasonId: season.id,
      });

      const result = await pruneSeasonsBeyondHorizon(db, { leagueId, currentYear: 2026 });
      expect(result.removed).not.toContain(2029);
      expect(result.kept.map((k) => k.year)).toContain(2029);
      // Deleting it would have cascaded to picks and orphaned the ledger.
      expect(await db.query.seasons.findFirst({ where: eq(schema.seasons.id, season.id) })).toBeDefined();
    });
  });

  describe("keeper rights follow the player", () => {
    it("rejects a standalone keeper-rights trade", async () => {
      const player = await findOrCreatePlayerByName(db, "Bijan Robinson");
      const season = await db.query.seasons.findFirst({ where: eq(schema.seasons.year, 2027) });

      await expect(
        createTrade(db, member, {
          leagueId,
          loggedByTeamId: team.WFP.id,
          currentYear: 2026,
          assets: [
            {
              kind: "keeper_right",
              fromTeamId: team.WFP.id,
              toTeamId: team.SACK.id,
              playerId: player.id,
              seasonId: season!.id,
            },
          ],
        }),
      ).rejects.toThrow(/cannot be traded separately from the player/i);
    });

    it("allows trading the player itself", async () => {
      const player = await findOrCreatePlayerByName(db, "Bijan Robinson");
      const { trade } = await createTrade(db, member, {
        leagueId,
        loggedByTeamId: team.WFP.id,
        currentYear: 2026,
        assets: [
          {
            kind: "player",
            fromTeamId: team.WFP.id,
            toTeamId: team.SACK.id,
            playerId: player.id,
          },
        ],
      });
      expect(trade.status).toBe("pending");
    });
  });

  describe("players entered by name", () => {
    it("creates a player with no ESPN id", async () => {
      const p = await findOrCreatePlayerByName(db, "Saquon Barkley");
      expect(p.espnPlayerId).toBeNull();
      expect(p.fullName).toBe("Saquon Barkley");
    });

    it("matches case- and whitespace-insensitively instead of duplicating", async () => {
      const a = await findOrCreatePlayerByName(db, "Saquon Barkley");
      const b = await findOrCreatePlayerByName(db, "  saquon   barkley ");
      expect(b.id).toBe(a.id);
      expect(await db.query.players.findMany()).toHaveLength(1);
    });

    it("lets many un-synced players coexist despite the unique index", async () => {
      await findOrCreatePlayerByName(db, "Player One");
      await findOrCreatePlayerByName(db, "Player Two");
      await findOrCreatePlayerByName(db, "Player Three");
      const all = await db.query.players.findMany();
      expect(all).toHaveLength(3);
      expect(all.every((p) => p.espnPlayerId === null)).toBe(true);
    });
  });

  describe("commissioner backfill of past trades", () => {
    const backfillInput = () => ({
      leagueId,
      loggedByTeamId: team.WFP.id,
      currentYear: 2026,
      agreedOn: new Date("2025-10-14T00:00:00Z"),
      backfill: true,
      assets: [
        {
          kind: "draft_pick" as const,
          fromTeamId: team.WFP.id,
          toTeamId: team.SACK.id,
          draftPickId: 0,
        },
      ],
    });

    it("records a past trade as confirmed and moves the pick immediately", async () => {
      const pick = await pickOf("WFP", 2027, 3);
      const input = backfillInput();
      input.assets[0].draftPickId = pick!.id;

      const { trade } = await createTrade(db, commish, input);
      expect(trade.status).toBe("confirmed");
      expect(trade.confirmedByCommissioner).toBe(true);
      expect(trade.agreedOn?.toISOString()).toBe("2025-10-14T00:00:00.000Z");

      const after = await db.query.draftPicks.findFirst({
        where: eq(schema.draftPicks.id, pick!.id),
      });
      expect(after!.currentOwnerTeamId).toBe(team.SACK.id);
    });

    it("says in the audit trail that it was backfilled", async () => {
      const pick = await pickOf("WFP", 2027, 3);
      const input = backfillInput();
      input.assets[0].draftPickId = pick!.id;
      const { trade } = await createTrade(db, commish, input);

      const events = await db.query.tradeEvents.findMany({
        where: eq(schema.tradeEvents.tradeId, trade.id),
      });
      expect(events).toHaveLength(1);
      expect(events[0].note).toMatch(/backfilled by the commissioner/i);
      expect(events[0].actedAsCommissioner).toBe(true);
      expect(events[0].toStatus).toBe("confirmed");
    });

    it("is commissioner-only", async () => {
      const pick = await pickOf("WFP", 2027, 3);
      const input = backfillInput();
      input.assets[0].draftPickId = pick!.id;
      await expect(createTrade(db, member, input)).rejects.toThrow(/only the commissioner/i);
    });

    it("requires the date it was originally agreed", async () => {
      const pick = await pickOf("WFP", 2027, 3);
      const input = { ...backfillInput(), agreedOn: null };
      input.assets[0].draftPickId = pick!.id;
      await expect(createTrade(db, commish, input)).rejects.toThrow(/needs the date/i);
    });

    it("leaves normal trades pending, untouched by the backfill path", async () => {
      const pick = await pickOf("WFP", 2027, 3);
      const { trade } = await createTrade(db, member, {
        leagueId,
        loggedByTeamId: team.WFP.id,
        currentYear: 2026,
        assets: [
          {
            kind: "draft_pick",
            fromTeamId: team.WFP.id,
            toTeamId: team.SACK.id,
            draftPickId: pick!.id,
          },
        ],
      });
      expect(trade.status).toBe("pending");
      const after = await db.query.draftPicks.findFirst({
        where: eq(schema.draftPicks.id, pick!.id),
      });
      expect(after!.currentOwnerTeamId).toBe(team.WFP.id);
    });
  });
});
