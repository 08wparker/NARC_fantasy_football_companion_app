import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { rebuildDerivedState } from "@/db/derive";
import { ensureSeasonScaffold } from "@/db/picks";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";
import { makeTestDb, seedTestLeague } from "@/test/db";

/**
 * The one test suite that matters most.
 *
 * `draft_picks.current_owner_team_id` is a cache. If the rebuild is wrong, the
 * app confidently shows the wrong owner on draft night and nobody finds out
 * until it's too late to argue. So: hand-computed expectations, replayed
 * against real Postgres.
 */
describe("rebuildDerivedState", () => {
  let db: Db;
  let fx: Awaited<ReturnType<typeof seedTestLeague>>;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    fx = await seedTestLeague(db, { year: 2027, rounds: 3 });
  });

  /** Log a trade and immediately confirm it, at an explicit point in time. */
  async function confirmTrade(
    assets: Array<Partial<typeof schema.tradeAssets.$inferInsert>>,
    confirmedAt: Date,
  ) {
    const [trade] = await db
      .insert(schema.trades)
      .values({
        leagueId: fx.league.id,
        loggedByUserId: fx.user.id,
        loggedByTeamId: fx.team.WFP.id,
        status: "confirmed",
        confirmedAt,
        confirmedByUserId: fx.user.id,
      })
      .returning();

    await db.insert(schema.tradeAssets).values(
      assets.map((a) => ({
        tradeId: trade.id,
        kind: a.kind!,
        fromTeamId: a.fromTeamId!,
        toTeamId: a.toTeamId!,
        draftPickId: a.draftPickId ?? null,
        playerId: a.playerId ?? null,
        seasonId: a.seasonId ?? null,
        slotCount: a.slotCount ?? null,
      })),
    );
    return trade;
  }

  const ownerOf = async (pickId: number) =>
    (await db.query.draftPicks.findFirst({ where: eq(schema.draftPicks.id, pickId) }))!
      .currentOwnerTeamId;

  const boardOrder = async () => {
    const rows = await db.query.draftOrder.findMany({
      where: eq(schema.draftOrder.seasonId, fx.season.id),
      orderBy: (o, { asc }) => [asc(o.position)],
    });
    const byId = new Map(fx.teams.map((t) => [t.id, t.abbrev]));
    return rows.map((r) => byId.get(r.currentTeamId)!);
  };

  it("leaves every pick with its original owner when nothing is confirmed", async () => {
    const { warnings } = await rebuildDerivedState(db, fx.season.id);
    expect(warnings).toEqual([]);
    expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.WFP.id);
  });

  it("moves a traded pick to the receiving team", async () => {
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: fx.pick("WFP", 3).id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );

    await rebuildDerivedState(db, fx.season.id);
    expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.SACK.id);
    // untouched picks stay put
    expect(await ownerOf(fx.pick("WFP", 1).id)).toBe(fx.team.WFP.id);
  });

  it("follows a chain: WFP -> SACK -> NOVA lands on NOVA", async () => {
    const pick = fx.pick("WFP", 3);
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: pick.id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.SACK.id,
          toTeamId: fx.team.NOVA.id,
          draftPickId: pick.id,
        },
      ],
      new Date("2026-10-01T00:00:00Z"),
    );

    const { warnings } = await rebuildDerivedState(db, fx.season.id);
    expect(warnings).toEqual([]);
    expect(await ownerOf(pick.id)).toBe(fx.team.NOVA.id);
  });

  it("replays in confirmation order, not insertion order", async () => {
    const pick = fx.pick("WFP", 3);
    // Inserted backwards: the SACK->NOVA leg is written first but agreed later.
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.SACK.id,
          toTeamId: fx.team.NOVA.id,
          draftPickId: pick.id,
        },
      ],
      new Date("2026-10-01T00:00:00Z"),
    );
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: pick.id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );

    const { warnings } = await rebuildDerivedState(db, fx.season.id);
    expect(warnings).toEqual([]);
    expect(await ownerOf(pick.id)).toBe(fx.team.NOVA.id);
  });

  it("ignores pending, rejected and voided trades", async () => {
    const pick = fx.pick("WFP", 3);
    for (const status of ["pending", "rejected", "cancelled", "voided"] as const) {
      const [trade] = await db
        .insert(schema.trades)
        .values({
          leagueId: fx.league.id,
          loggedByUserId: fx.user.id,
          loggedByTeamId: fx.team.WFP.id,
          status,
          // voided trades legitimately retain their confirmation metadata
          ...(status === "voided"
            ? { confirmedAt: new Date("2026-09-01T00:00:00Z"), confirmedByUserId: fx.user.id }
            : {}),
        })
        .returning();
      await db.insert(schema.tradeAssets).values({
        tradeId: trade.id,
        kind: "draft_pick",
        fromTeamId: fx.team.WFP.id,
        toTeamId: fx.team.SACK.id,
        draftPickId: pick.id,
      });
    }

    await rebuildDerivedState(db, fx.season.id);
    expect(await ownerOf(pick.id)).toBe(fx.team.WFP.id);
  });

  it("returns a pick to its original owner when the trade is voided", async () => {
    const pick = fx.pick("WFP", 3);
    const trade = await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: pick.id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );
    await rebuildDerivedState(db, fx.season.id);
    expect(await ownerOf(pick.id)).toBe(fx.team.SACK.id);

    await db.update(schema.trades).set({ status: "voided" }).where(eq(schema.trades.id, trade.id));
    await rebuildDerivedState(db, fx.season.id);
    expect(await ownerOf(pick.id)).toBe(fx.team.WFP.id);
  });

  it("voiding the first leg of a chain still leaves the second leg applied", async () => {
    const pick = fx.pick("WFP", 3);
    const first = await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: pick.id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.SACK.id,
          toTeamId: fx.team.NOVA.id,
          draftPickId: pick.id,
        },
      ],
      new Date("2026-10-01T00:00:00Z"),
    );

    await db.update(schema.trades).set({ status: "voided" }).where(eq(schema.trades.id, first.id));
    const { warnings } = await rebuildDerivedState(db, fx.season.id);

    // NOVA still ends up with it, but the ledger is now internally inconsistent
    // (SACK never legitimately owned it), and that must be surfaced.
    expect(await ownerOf(pick.id)).toBe(fx.team.NOVA.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("pick_not_owned_by_sender");
  });

  it("warns when a team trades a pick it does not hold", async () => {
    // DICK never owned WFP's 3rd.
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.DICK.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: fx.pick("WFP", 3).id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );

    const { warnings } = await rebuildDerivedState(db, fx.season.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("pick_not_owned_by_sender");
  });

  describe("draft slot swaps", () => {
    it("exchanges two teams' board positions", async () => {
      const before = await boardOrder();
      expect(before[0]).toBe("SACK");
      expect(before[2]).toBe("WFP");

      await confirmTrade(
        [
          {
            kind: "draft_slot_swap",
            fromTeamId: fx.team.SACK.id,
            toTeamId: fx.team.WFP.id,
            seasonId: fx.season.id,
          },
        ],
        new Date("2026-09-01T00:00:00Z"),
      );
      await rebuildDerivedState(db, fx.season.id);

      const after = await boardOrder();
      expect(after[0]).toBe("WFP");
      expect(after[2]).toBe("SACK");
      // everyone else is untouched
      expect(after[1]).toBe("BUES");
      expect(after.slice(3)).toEqual(before.slice(3));
    });

    it("is undone cleanly by a void (the transient unique-index case)", async () => {
      const before = await boardOrder();
      const trade = await confirmTrade(
        [
          {
            kind: "draft_slot_swap",
            fromTeamId: fx.team.SACK.id,
            toTeamId: fx.team.WFP.id,
            seasonId: fx.season.id,
          },
        ],
        new Date("2026-09-01T00:00:00Z"),
      );
      await rebuildDerivedState(db, fx.season.id);
      expect(await boardOrder()).not.toEqual(before);

      await db
        .update(schema.trades)
        .set({ status: "voided" })
        .where(eq(schema.trades.id, trade.id));
      await rebuildDerivedState(db, fx.season.id);

      expect(await boardOrder()).toEqual(before);
    });

    it("composes with pick trades without either knowing about the other", async () => {
      // SACK and WFP swap slots; separately WFP's 3rd goes to NOVA.
      await confirmTrade(
        [
          {
            kind: "draft_slot_swap",
            fromTeamId: fx.team.SACK.id,
            toTeamId: fx.team.WFP.id,
            seasonId: fx.season.id,
          },
          {
            kind: "draft_pick",
            fromTeamId: fx.team.WFP.id,
            toTeamId: fx.team.NOVA.id,
            draftPickId: fx.pick("WFP", 3).id,
          },
        ],
        new Date("2026-09-01T00:00:00Z"),
      );
      await rebuildDerivedState(db, fx.season.id);

      const after = await boardOrder();
      expect(after[0]).toBe("WFP"); // slot moved
      expect(await ownerOf(fx.pick("WFP", 3).id)).toBe(fx.team.NOVA.id); // pick moved
      expect(await ownerOf(fx.pick("WFP", 1).id)).toBe(fx.team.WFP.id); // rest of WFP's picks intact
    });

    it("chains two swaps in confirmation order", async () => {
      // SACK <-> WFP, then WFP <-> NOVA. Positions: 1 SACK, 3 WFP, 4 NOVA.
      await confirmTrade(
        [
          {
            kind: "draft_slot_swap",
            fromTeamId: fx.team.SACK.id,
            toTeamId: fx.team.WFP.id,
            seasonId: fx.season.id,
          },
        ],
        new Date("2026-09-01T00:00:00Z"),
      );
      await confirmTrade(
        [
          {
            kind: "draft_slot_swap",
            fromTeamId: fx.team.WFP.id,
            toTeamId: fx.team.NOVA.id,
            seasonId: fx.season.id,
          },
        ],
        new Date("2026-10-01T00:00:00Z"),
      );
      await rebuildDerivedState(db, fx.season.id);

      // After swap 1: pos1=WFP, pos3=SACK, pos4=NOVA
      // After swap 2 (WFP at pos1 <-> NOVA at pos4): pos1=NOVA, pos4=WFP
      const after = await boardOrder();
      expect(after[0]).toBe("NOVA");
      expect(after[2]).toBe("SACK");
      expect(after[3]).toBe("WFP");
    });
  });

  it("is idempotent — rebuilding twice changes nothing", async () => {
    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: fx.pick("WFP", 3).id,
        },
        {
          kind: "draft_slot_swap",
          fromTeamId: fx.team.BUES.id,
          toTeamId: fx.team.DICK.id,
          seasonId: fx.season.id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );

    await rebuildDerivedState(db, fx.season.id);
    const owners1 = await db.query.draftPicks.findMany({
      where: eq(schema.draftPicks.seasonId, fx.season.id),
      orderBy: (p, { asc }) => [asc(p.id)],
    });
    const board1 = await boardOrder();

    await rebuildDerivedState(db, fx.season.id);
    const owners2 = await db.query.draftPicks.findMany({
      where: eq(schema.draftPicks.seasonId, fx.season.id),
      orderBy: (p, { asc }) => [asc(p.id)],
    });

    expect(owners2.map((p) => p.currentOwnerTeamId)).toEqual(
      owners1.map((p) => p.currentOwnerTeamId),
    );
    expect(await boardOrder()).toEqual(board1);
  });

  it("does not touch picks belonging to another season", async () => {
    // A second season in the same league — the realistic case, since a keeper
    // league carries several future drafts at once.
    const other = await ensureSeasonScaffold(db, {
      leagueId: fx.league.id,
      year: 2028,
      currentYear: 2026,
      draftRounds: 2,
    });

    await confirmTrade(
      [
        {
          kind: "draft_pick",
          fromTeamId: fx.team.WFP.id,
          toTeamId: fx.team.SACK.id,
          draftPickId: fx.pick("WFP", 3).id,
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );

    await rebuildDerivedState(db, fx.season.id);

    const otherPicks = await db.query.draftPicks.findMany({
      where: eq(schema.draftPicks.seasonId, other.id),
    });
    expect(otherPicks).toHaveLength(12 * 2);
    expect(otherPicks.every((p) => p.currentOwnerTeamId === p.originalTeamId)).toBe(true);
  });

  it("scopes a slot swap to its own season", async () => {
    const other = await ensureSeasonScaffold(db, {
      leagueId: fx.league.id,
      year: 2028,
      currentYear: 2026,
      draftRounds: 2,
    });

    await confirmTrade(
      [
        {
          kind: "draft_slot_swap",
          fromTeamId: fx.team.SACK.id,
          toTeamId: fx.team.WFP.id,
          seasonId: other.id, // swap applies to 2028, not 2027
        },
      ],
      new Date("2026-09-01T00:00:00Z"),
    );

    const before = await boardOrder();
    await rebuildDerivedState(db, fx.season.id);
    expect(await boardOrder()).toEqual(before);

    await rebuildDerivedState(db, other.id);
    const otherOrder = await db.query.draftOrder.findMany({
      where: eq(schema.draftOrder.seasonId, other.id),
      orderBy: (o, { asc }) => [asc(o.position)],
    });
    const byId = new Map(fx.teams.map((t) => [t.id, t.abbrev]));
    expect(byId.get(otherOrder[0].currentTeamId)).toBe("WFP");
    expect(byId.get(otherOrder[2].currentTeamId)).toBe("SACK");
  });
});
