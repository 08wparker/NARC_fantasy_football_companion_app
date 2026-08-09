import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  cancelTrade,
  confirmTrade,
  createTrade,
  pendingForActor,
  rejectTrade,
  voidTrade,
} from "@/db/trade-service";
import type { Db } from "@/db/types";
import { makeTestDb, seedTestLeague } from "@/test/db";

describe("trade service", () => {
  let db: Db;
  let fx: Awaited<ReturnType<typeof seedTestLeague>>;

  // WFP logs; SACK is the counterparty; DICK is uninvolved.
  let wfp: { userId: number; teamIds: number[]; isCommissioner: boolean };
  let sack: typeof wfp;
  let dick: typeof wfp;
  let commish: typeof wfp;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    fx = await seedTestLeague(db, { year: 2027, rounds: 3 });

    wfp = { userId: fx.user.id, teamIds: [fx.team.WFP.id], isCommissioner: false };
    sack = { userId: fx.user.id, teamIds: [fx.team.SACK.id], isCommissioner: false };
    dick = { userId: fx.user.id, teamIds: [fx.team.DICK.id], isCommissioner: false };
    commish = { userId: fx.user.id, teamIds: [fx.team.MAYE.id], isCommissioner: true };
  });

  const pickTrade = () => ({
    leagueId: fx.league.id,
    loggedByTeamId: fx.team.WFP.id,
    assets: [
      {
        kind: "draft_pick" as const,
        fromTeamId: fx.team.WFP.id,
        toTeamId: fx.team.SACK.id,
        draftPickId: fx.pick("WFP", 3).id,
      },
    ],
  });

  const ownerOf = async (pickId: number) =>
    (await db.query.draftPicks.findFirst({ where: eq(schema.draftPicks.id, pickId) }))!
      .currentOwnerTeamId;

  describe("create", () => {
    it("logs a pending trade that does not move anything yet", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      expect(trade.status).toBe("pending");
      // Crucially: pending changes nothing.
      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.WFP.id);
    });

    it("writes a created audit event", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      const events = await db.query.tradeEvents.findMany({
        where: eq(schema.tradeEvents.tradeId, trade.id),
      });
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe("created");
      expect(events[0].toStatus).toBe("pending");
    });

    it("refuses to log a trade for a franchise you do not manage", async () => {
      await expect(createTrade(db, dick, pickTrade())).rejects.toThrow(/franchise you manage/i);
    });

    it("refuses to trade a pick the sender does not own", async () => {
      await expect(
        createTrade(db, wfp, {
          leagueId: fx.league.id,
          loggedByTeamId: fx.team.WFP.id,
          assets: [
            {
              kind: "draft_pick",
              fromTeamId: fx.team.WFP.id,
              toTeamId: fx.team.SACK.id,
              draftPickId: fx.pick("DICK", 1).id, // WFP never owned this
            },
          ],
        }),
      ).rejects.toThrow(/does not own/i);
    });

    it("refuses a trade with only one team", async () => {
      await expect(
        createTrade(db, wfp, {
          leagueId: fx.league.id,
          loggedByTeamId: fx.team.WFP.id,
          assets: [
            {
              kind: "draft_pick",
              fromTeamId: fx.team.WFP.id,
              toTeamId: fx.team.WFP.id,
              draftPickId: fx.pick("WFP", 1).id,
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it("refuses to trade the same pick twice in one trade", async () => {
      await expect(
        createTrade(db, wfp, {
          leagueId: fx.league.id,
          loggedByTeamId: fx.team.WFP.id,
          assets: [
            {
              kind: "draft_pick",
              fromTeamId: fx.team.WFP.id,
              toTeamId: fx.team.SACK.id,
              draftPickId: fx.pick("WFP", 3).id,
            },
            {
              kind: "draft_pick",
              fromTeamId: fx.team.WFP.id,
              toTeamId: fx.team.NOVA.id,
              draftPickId: fx.pick("WFP", 3).id,
            },
          ],
        }),
      ).rejects.toThrow(/twice/i);
    });
  });

  describe("confirm", () => {
    it("moves the pick once the counterparty confirms", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await confirmTrade(db, sack, trade.id);
      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.SACK.id);
    });

    it("refuses to let the proposer confirm their own trade", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await expect(confirmTrade(db, wfp, trade.id)).rejects.toThrow(/counterparty/i);
      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.WFP.id);
    });

    it("refuses confirmation from an uninvolved team", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await expect(confirmTrade(db, dick, trade.id)).rejects.toThrow(/counterparty/i);
    });

    it("lets the commissioner confirm as a referee, and records that they did", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await confirmTrade(db, commish, trade.id);

      const row = await db.query.trades.findFirst({ where: eq(schema.trades.id, trade.id) });
      expect(row!.status).toBe("confirmed");
      expect(row!.confirmedByCommissioner).toBe(true);
      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.SACK.id);
    });

    it("cannot confirm the same trade twice", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await confirmTrade(db, sack, trade.id);
      await expect(confirmTrade(db, sack, trade.id)).rejects.toThrow(/pending/i);
    });
  });

  describe("reject and cancel", () => {
    it("lets the counterparty reject, leaving ownership untouched", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await rejectTrade(db, sack, trade.id, "nah");

      const row = await db.query.trades.findFirst({ where: eq(schema.trades.id, trade.id) });
      expect(row!.status).toBe("rejected");
      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.WFP.id);
    });

    it("lets the proposer cancel but not the counterparty", async () => {
      const a = await createTrade(db, wfp, pickTrade());
      await expect(cancelTrade(db, sack, a.trade.id)).rejects.toThrow(/logged this trade/i);
      await cancelTrade(db, wfp, a.trade.id);
      const row = await db.query.trades.findFirst({ where: eq(schema.trades.id, a.trade.id) });
      expect(row!.status).toBe("cancelled");
    });
  });

  describe("void", () => {
    it("returns the pick and keeps the reason on the record", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await confirmTrade(db, sack, trade.id);
      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.SACK.id);

      await voidTrade(db, commish, trade.id, "logged against the wrong team");

      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.WFP.id);
      const events = await db.query.tradeEvents.findMany({
        where: eq(schema.tradeEvents.tradeId, trade.id),
        orderBy: (e, { asc }) => [asc(e.id)],
      });
      expect(events.map((e) => e.action)).toEqual(["created", "confirmed", "voided"]);
      expect(events[2].note).toMatch(/wrong team/);
    });

    it("is commissioner-only", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await confirmTrade(db, sack, trade.id);
      await expect(voidTrade(db, sack, trade.id, "changed my mind")).rejects.toThrow(
        /commissioner/i,
      );
      await expect(voidTrade(db, wfp, trade.id, "changed my mind")).rejects.toThrow(
        /commissioner/i,
      );
    });

    it("requires a reason", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await confirmTrade(db, sack, trade.id);
      await expect(voidTrade(db, commish, trade.id, "   ")).rejects.toThrow(/reason/i);
    });

    it("never deletes the original assets", async () => {
      const { trade } = await createTrade(db, wfp, pickTrade());
      await confirmTrade(db, sack, trade.id);
      await voidTrade(db, commish, trade.id, "mistake");

      const assets = await db.query.tradeAssets.findMany({
        where: eq(schema.tradeAssets.tradeId, trade.id),
      });
      expect(assets).toHaveLength(1);
      expect(assets[0].draftPickId).toBe(fx.pick("WFP", 3).id);
    });
  });

  describe("mixed-asset trades", () => {
    it("handles a pick, a slot swap and keeper slots in one trade", async () => {
      const { trade } = await createTrade(db, wfp, {
        leagueId: fx.league.id,
        loggedByTeamId: fx.team.WFP.id,
        assets: [
          {
            kind: "draft_pick",
            fromTeamId: fx.team.WFP.id,
            toTeamId: fx.team.SACK.id,
            draftPickId: fx.pick("WFP", 3).id,
          },
          {
            kind: "draft_slot_swap",
            fromTeamId: fx.team.WFP.id,
            toTeamId: fx.team.SACK.id,
            seasonId: fx.season.id,
          },
          {
            kind: "keeper_slot",
            fromTeamId: fx.team.SACK.id,
            toTeamId: fx.team.WFP.id,
            seasonId: fx.season.id,
            slotCount: 1,
          },
        ],
      });

      await confirmTrade(db, sack, trade.id);

      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.SACK.id);
      const order = await db.query.draftOrder.findMany({
        where: eq(schema.draftOrder.seasonId, fx.season.id),
        orderBy: (o, { asc }) => [asc(o.position)],
      });
      expect(order[0].currentTeamId).toBe(fx.team.WFP.id); // slots swapped
      expect(order[2].currentTeamId).toBe(fx.team.SACK.id);
    });

    it("supports a three-way trade with no extra modeling", async () => {
      const { trade } = await createTrade(db, wfp, {
        leagueId: fx.league.id,
        loggedByTeamId: fx.team.WFP.id,
        assets: [
          {
            kind: "draft_pick",
            fromTeamId: fx.team.WFP.id,
            toTeamId: fx.team.SACK.id,
            draftPickId: fx.pick("WFP", 1).id,
          },
          {
            kind: "draft_pick",
            fromTeamId: fx.team.SACK.id,
            toTeamId: fx.team.NOVA.id,
            draftPickId: fx.pick("SACK", 1).id,
          },
          {
            kind: "draft_pick",
            fromTeamId: fx.team.NOVA.id,
            toTeamId: fx.team.WFP.id,
            draftPickId: fx.pick("NOVA", 1).id,
          },
        ],
      });
      await confirmTrade(db, sack, trade.id);

      expect(await ownerOf(fx.pick("WFP", 1).id)).toBe(fx.team.SACK.id);
      expect(await ownerOf(fx.pick("SACK", 1).id)).toBe(fx.team.NOVA.id);
      expect(await ownerOf(fx.pick("NOVA", 1).id)).toBe(fx.team.WFP.id);
    });
  });

  describe("pending inbox", () => {
    it("shows a trade to the counterparty but not to the proposer", async () => {
      await createTrade(db, wfp, pickTrade());

      expect(await pendingForActor(db, fx.league.id, sack)).toHaveLength(1);
      expect(await pendingForActor(db, fx.league.id, wfp)).toHaveLength(0);
      expect(await pendingForActor(db, fx.league.id, dick)).toHaveLength(0);
    });

    it("shows every pending trade to the commissioner", async () => {
      await createTrade(db, wfp, pickTrade());
      expect(await pendingForActor(db, fx.league.id, commish)).toHaveLength(1);
    });
  });
});
