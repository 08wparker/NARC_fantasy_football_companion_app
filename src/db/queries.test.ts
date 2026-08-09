import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { rebuildDerivedState } from "@/db/derive";
import { draftBoard, pickProvenance, picksOwnedByTeam } from "@/db/queries";
import * as schema from "@/db/schema";
import { confirmTrade, createTrade } from "@/db/trade-service";
import type { Db } from "@/db/types";
import { makeTestDb, seedTestLeague } from "@/test/db";

describe("draftBoard", () => {
  let db: Db;
  let fx: Awaited<ReturnType<typeof seedTestLeague>>;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    fx = await seedTestLeague(db, { year: 2027, rounds: 3 });
  });

  it("orders a snake draft correctly", async () => {
    const board = await draftBoard(db, fx.season.id);
    expect(board).toHaveLength(12 * 3);

    const r1 = board.filter((p) => p.round === 1);
    const r2 = board.filter((p) => p.round === 2);
    const r3 = board.filter((p) => p.round === 3);

    // Round 1 runs 1..12 in slot order.
    expect(r1.map((p) => p.overall)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r1[0].originalTeam.abbrev).toBe("SACK");
    expect(r1[11].originalTeam.abbrev).toBe("WW");

    // Round 2 reverses: the team in slot 12 picks first (overall 13).
    expect(r2[0].overall).toBe(13);
    expect(r2[0].originalTeam.abbrev).toBe("WW");
    expect(r2[11].overall).toBe(24);
    expect(r2[11].originalTeam.abbrev).toBe("SACK");

    // Round 3 snaps back.
    expect(r3[0].overall).toBe(25);
    expect(r3[0].originalTeam.abbrev).toBe("SACK");
  });

  it("uses straight order for a non-snake draft", async () => {
    await db
      .update(schema.seasons)
      .set({ isSnakeDraft: false })
      .where(eq(schema.seasons.id, fx.season.id));

    const board = await draftBoard(db, fx.season.id);
    const r2 = board.filter((p) => p.round === 2);
    expect(r2[0].overall).toBe(13);
    expect(r2[0].originalTeam.abbrev).toBe("SACK"); // not reversed
  });

  it("keeps a traded pick in its original team's board slot", async () => {
    const actor = { userId: fx.user.id, teamIds: [fx.team.WFP.id], isCommissioner: false };
    const counter = { userId: fx.user.id, teamIds: [fx.team.SACK.id], isCommissioner: false };

    const { trade } = await createTrade(db, actor, {
      leagueId: fx.league.id,
      loggedByTeamId: fx.team.WFP.id,
      assets: [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: fx.pick("WFP", 1).id,
        },
      ],
    });
    await confirmTrade(db, counter, trade.id);

    const board = await draftBoard(db, fx.season.id);
    const traded = board.find((p) => p.pickId === fx.pick("WFP", 1).id)!;

    // WFP sits in slot 3, so the pick is still overall 3 — but SACK owns it.
    expect(traded.overall).toBe(3);
    expect(traded.originalTeam.abbrev).toBe("WFP");
    expect(traded.currentOwner.abbrev).toBe("SACK");
    expect(traded.isTraded).toBe(true);
  });

  it("moves a team's whole set of picks when their slot is swapped", async () => {
    const actor = { userId: fx.user.id, teamIds: [fx.team.WFP.id], isCommissioner: false };
    const counter = { userId: fx.user.id, teamIds: [fx.team.SACK.id], isCommissioner: false };

    const { trade } = await createTrade(db, actor, {
      leagueId: fx.league.id,
      loggedByTeamId: fx.team.WFP.id,
      assets: [
        {
          kind: "draft_slot_swap",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          seasonId: fx.season.id,
        },
      ],
    });
    await confirmTrade(db, counter, trade.id);

    const board = await draftBoard(db, fx.season.id);
    const r1 = board.filter((p) => p.round === 1);

    // WFP now holds slot 1 and SACK slot 3 — every round follows.
    expect(r1[0].originalTeam.abbrev).toBe("WFP");
    expect(r1[2].originalTeam.abbrev).toBe("SACK");

    const wfpPicks = board.filter((p) => p.originalTeam.abbrev === "WFP");
    expect(wfpPicks.map((p) => p.overall).sort((a, b) => a - b)).toEqual([1, 24, 25]);
    // Ownership is untouched — a slot swap moves position, not the picks.
    expect(wfpPicks.every((p) => p.currentOwner.abbrev === "WFP")).toBe(true);
  });
});

describe("pickProvenance", () => {
  let db: Db;
  let fx: Awaited<ReturnType<typeof seedTestLeague>>;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    fx = await seedTestLeague(db, { year: 2027, rounds: 3 });
  });

  it("is empty for an untraded pick", async () => {
    expect(await pickProvenance(db, fx.pick("WFP", 1).id)).toEqual([]);
  });

  it("reads as the chain of hands the pick has passed through", async () => {
    const pick = fx.pick("WFP", 3);
    const mk = async (fromAbbrev: "WFP" | "SACK", toAbbrev: "SACK" | "NOVA") => {
      const from = fx.team[fromAbbrev];
      const to = fx.team[toAbbrev];
      const { trade } = await createTrade(
        db,
        { userId: fx.user.id, teamIds: [from.id], isCommissioner: false },
        {
          leagueId: fx.league.id,
          loggedByTeamId: from.id,
          assets: [
            { kind: "draft_pick", fromTeamId: from.id, toTeamId: to.id, draftPickId: pick.id },
          ],
        },
      );
      await confirmTrade(
        db,
        { userId: fx.user.id, teamIds: [to.id], isCommissioner: false },
        trade.id,
      );
    };

    await mk("WFP", "SACK");
    await mk("SACK", "NOVA");

    const chain = await pickProvenance(db, pick.id);
    expect(chain.map((h) => `${h.from}->${h.to}`)).toEqual(["WFP->SACK", "SACK->NOVA"]);
  });

  it("drops a voided hop from the chain", async () => {
    const pick = fx.pick("WFP", 3);
    const { trade } = await createTrade(
      db,
      { userId: fx.user.id, teamIds: [fx.team.WFP.id], isCommissioner: false },
      {
        leagueId: fx.league.id,
        loggedByTeamId: fx.team.WFP.id,
        assets: [
          {
            kind: "draft_pick",
            fromTeamId: fx.team.WFP.id,
            toTeamId: fx.team.SACK.id,
            draftPickId: pick.id,
          },
        ],
      },
    );
    await confirmTrade(
      db,
      { userId: fx.user.id, teamIds: [fx.team.SACK.id], isCommissioner: false },
      trade.id,
    );
    expect(await pickProvenance(db, pick.id)).toHaveLength(1);

    await db.update(schema.trades).set({ status: "voided" }).where(eq(schema.trades.id, trade.id));
    await rebuildDerivedState(db, fx.season.id);
    expect(await pickProvenance(db, pick.id)).toEqual([]);
  });
});

describe("picksOwnedByTeam", () => {
  it("groups a franchise's holdings by season", async () => {
    const { db } = await makeTestDb();
    const fx = await seedTestLeague(db, { year: 2027, rounds: 3 });

    const owned = await picksOwnedByTeam(db, fx.team.WFP.id);
    expect(owned).toHaveLength(1);
    expect(owned[0].year).toBe(2027);
    expect(owned[0].picks.map((p) => p.round)).toEqual([1, 2, 3]);
  });
});
