import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { Db } from "@/db/types";
import { expectConstraintViolation, makeTestDb, seedTestLeague } from "@/test/db";

/**
 * These prove the integrity rules are enforced by Postgres itself, not by
 * application code someone can forget to call. Each case is something a buggy
 * server action could plausibly attempt.
 */
describe("database-enforced integrity", () => {
  let db: Db;
  let fx: Awaited<ReturnType<typeof seedTestLeague>>;

  beforeAll(async () => {
    ({ db } = await makeTestDb());
    fx = await seedTestLeague(db);
  });

  async function makePendingTrade() {
    const [trade] = await db
      .insert(schema.trades)
      .values({
        leagueId: fx.league.id,
        loggedByUserId: fx.user.id,
        loggedByTeamId: fx.team.WFP.id,
      })
      .returning();
    return trade;
  }

  describe("trade_assets discriminant", () => {
    it("rejects a draft_pick asset with no pick attached", async () => {
      const trade = await makePendingTrade();
      await expectConstraintViolation(
        db.insert(schema.tradeAssets).values({
          tradeId: trade.id,
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: null,
        }),
        "trade_assets_kind_shape",
      );
    });

    it("rejects a keeper_slot asset with no slot count", async () => {
      const trade = await makePendingTrade();
      await expectConstraintViolation(
        db.insert(schema.tradeAssets).values({
          tradeId: trade.id,
          kind: "keeper_slot",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          seasonId: fx.season.id,
        }),
        "trade_assets_kind_shape",
      );
    });

    it("rejects a draft_pick asset that also smuggles in a player", async () => {
      const trade = await makePendingTrade();
      const [player] = await db
        .insert(schema.players)
        .values({ espnPlayerId: 4366031, fullName: "Test Player" })
        .returning();

      await expectConstraintViolation(
        db.insert(schema.tradeAssets).values({
          tradeId: trade.id,
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: fx.pick("WFP", 3).id,
          playerId: player.id,
        }),
        "trade_assets_kind_shape",
      );
    });

    it("rejects a team trading with itself", async () => {
      const trade = await makePendingTrade();
      await expectConstraintViolation(
        db.insert(schema.tradeAssets).values({
          tradeId: trade.id,
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.WFP.id,
          draftPickId: fx.pick("WFP", 2).id,
        }),
        "trade_assets_distinct_parties",
      );
    });

    it("accepts a well-formed draft_pick asset", async () => {
      const trade = await makePendingTrade();
      const [asset] = await db
        .insert(schema.tradeAssets)
        .values({
          tradeId: trade.id,
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: fx.pick("WFP", 1).id,
        })
        .returning();
      expect(asset.kind).toBe("draft_pick");
    });
  });

  describe("trade lifecycle", () => {
    it("refuses to mark a trade confirmed without confirmation metadata", async () => {
      const trade = await makePendingTrade();
      await expectConstraintViolation(
        db
          .update(schema.trades)
          .set({ status: "confirmed" }) // no confirmedAt / confirmedByUserId
          .where(eq(schema.trades.id, trade.id)),
        "trades_confirmed_shape",
      );
    });
  });

  describe("voting", () => {
    it("allows only one ballot per franchise per proposal", async () => {
      const [proposal] = await db
        .insert(schema.proposals)
        .values({
          leagueId: fx.league.id,
          title: "Expand to 14 teams",
          body: "...",
          proposedByUserId: fx.user.id,
        })
        .returning();

      await db.insert(schema.votes).values({
        proposalId: proposal.id,
        teamId: fx.team.BUES.id,
        choice: "yes",
        castByUserId: fx.user.id,
      });

      // The second Buesing account tries to vote again for the same franchise.
      await expectConstraintViolation(
        db.insert(schema.votes).values({
          proposalId: proposal.id,
          teamId: fx.team.BUES.id,
          choice: "no",
          castByUserId: fx.user.id,
        }),
        "votes_proposal_team_uq",
      );
    });

    it("refuses to open a proposal without a deadline and voter count", async () => {
      const [proposal] = await db
        .insert(schema.proposals)
        .values({
          leagueId: fx.league.id,
          title: "Ban kickers",
          body: "...",
          proposedByUserId: fx.user.id,
        })
        .returning();

      await expectConstraintViolation(
        db
          .update(schema.proposals)
          .set({ status: "open", openedAt: new Date() }) // missing closesAt + eligibleVoterCount
          .where(eq(schema.proposals.id, proposal.id)),
        "proposals_open_shape",
      );
    });

    it("rejects an impossible threshold", async () => {
      await expectConstraintViolation(
        db.insert(schema.proposals).values({
          leagueId: fx.league.id,
          title: "Needs 4/3 of the league",
          body: "...",
          proposedByUserId: fx.user.id,
          thresholdNumerator: 4,
          thresholdDenominator: 3,
        }),
        "proposals_threshold_valid",
      );
    });
  });

  describe("draft order", () => {
    it("refuses to land two teams on one draft slot", async () => {
      // A half-applied swap: move SACK onto WFP's position without moving WFP.
      await expectConstraintViolation(
        db
          .update(schema.draftOrder)
          .set({ currentTeamId: fx.team.WFP.id })
          .where(eq(schema.draftOrder.currentTeamId, fx.team.SACK.id)),
        "draft_order_season_current_team_uq",
      );
    });
  });

  describe("draft picks", () => {
    it("refuses duplicate picks for the same season/round/original team", async () => {
      await expectConstraintViolation(
        db.insert(schema.draftPicks).values({
          seasonId: fx.season.id,
          round: 1,
          originalTeamId: fx.team.WFP.id,
          currentOwnerTeamId: fx.team.WFP.id,
        }),
        "draft_picks_season_round_origin_uq",
      );
    });
  });
});
