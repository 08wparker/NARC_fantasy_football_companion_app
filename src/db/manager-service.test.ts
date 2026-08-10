import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assignUserToSeat,
  setInviteEmail,
  setLeagueRole,
  setSeatActive,
  unlinkSeat,
} from "@/db/manager-service";
import * as schema from "@/db/schema";
import { seedLeague } from "@/db/seed";
import type { Db } from "@/db/types";
import { makeTestDb } from "@/test/db";

describe("manager seat service", () => {
  let db: Db;
  let leagueId: number;

  const seatFor = async (abbrev: string) => {
    const team = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, abbrev) });
    const seats = await db.query.teamManagers.findMany({
      where: eq(schema.teamManagers.teamId, team!.id),
      orderBy: (m, { asc }) => [asc(m.id)],
    });
    return seats[0];
  };

  const makeUser = async (clerkUserId: string, email: string) => {
    const [u] = await db
      .insert(schema.users)
      .values({ clerkUserId, email, displayName: clerkUserId })
      .returning();
    return u;
  };

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    const { league } = await seedLeague(db, { espnLeagueId: "718396", currentYear: 2026 });
    leagueId = league.id;
  });

  describe("invite emails", () => {
    it("sets and normalizes an invite email", async () => {
      const seat = await seatFor("HULL");
      await setInviteEmail(db, leagueId, seat.id, "  Tyler@Example.COM ");

      const after = await db.query.teamManagers.findFirst({
        where: eq(schema.teamManagers.id, seat.id),
      });
      expect(after!.inviteEmail).toBe("tyler@example.com");
    });

    it("rejects something that is not an email", async () => {
      const seat = await seatFor("HULL");
      await expect(setInviteEmail(db, leagueId, seat.id, "tyler")).rejects.toThrow(
        /does not look like an email/i,
      );
    });

    it("allows clearing an invite email", async () => {
      const seat = await seatFor("WFP");
      await setInviteEmail(db, leagueId, seat.id, null);
      const after = await db.query.teamManagers.findFirst({
        where: eq(schema.teamManagers.id, seat.id),
      });
      expect(after!.inviteEmail).toBeNull();
    });

    it("refuses a seat from outside the league", async () => {
      await expect(setInviteEmail(db, leagueId, 99999, "x@y.com")).rejects.toThrow(
        /does not exist/i,
      );
    });
  });

  describe("assigning users", () => {
    it("attaches a signed-up user to a seat", async () => {
      const seat = await seatFor("HULL");
      const user = await makeUser("clerk_tyler", "tyler@example.com");

      await assignUserToSeat(db, leagueId, seat.id, user.id);

      const after = await db.query.teamManagers.findFirst({
        where: eq(schema.teamManagers.id, seat.id),
      });
      expect(after!.userId).toBe(user.id);
    });

    it("refuses to give one person two seats on the same franchise", async () => {
      const team = await db.query.teams.findFirst({ where: eq(schema.teams.abbrev, "BUES") });
      const seats = await db.query.teamManagers.findMany({
        where: eq(schema.teamManagers.teamId, team!.id),
        orderBy: (m, { asc }) => [asc(m.id)],
      });
      const user = await makeUser("clerk_rob", "rob@example.com");

      await assignUserToSeat(db, leagueId, seats[0].id, user.id);
      await expect(assignUserToSeat(db, leagueId, seats[1].id, user.id)).rejects.toThrow(
        /already holds a seat/i,
      );
    });

    it("is a no-op when the user already holds that seat", async () => {
      const seat = await seatFor("HULL");
      const user = await makeUser("clerk_tyler", "tyler@example.com");
      await assignUserToSeat(db, leagueId, seat.id, user.id);
      await expect(assignUserToSeat(db, leagueId, seat.id, user.id)).resolves.toBeUndefined();
    });

    it("refuses an unknown user", async () => {
      const seat = await seatFor("HULL");
      await expect(assignUserToSeat(db, leagueId, seat.id, 4242)).rejects.toThrow(
        /does not exist/i,
      );
    });
  });

  describe("last-commissioner guard", () => {
    /**
     * The seed makes SACK and WFP commissioner seats, but neither is *held*
     * until a user occupies it. These tests set up the real situation: one or
     * two live commissioners.
     */
    async function occupy(abbrev: string, clerkId: string) {
      const seat = await seatFor(abbrev);
      const user = await makeUser(clerkId, `${clerkId}@example.com`);
      await db
        .update(schema.teamManagers)
        .set({ userId: user.id })
        .where(eq(schema.teamManagers.id, seat.id));
      return { seat, user };
    }

    it("refuses to demote the only commissioner", async () => {
      const { seat } = await occupy("WFP", "clerk_wfp");

      await expect(setLeagueRole(db, leagueId, seat.id, "member")).rejects.toThrow(
        /only commissioner/i,
      );

      const after = await db.query.teamManagers.findFirst({
        where: eq(schema.teamManagers.id, seat.id),
      });
      expect(after!.leagueRole).toBe("commissioner");
    });

    it("refuses to unlink the only commissioner", async () => {
      const { seat } = await occupy("WFP", "clerk_wfp");
      await expect(unlinkSeat(db, leagueId, seat.id)).rejects.toThrow(/only commissioner/i);
    });

    it("refuses to deactivate the only commissioner", async () => {
      const { seat } = await occupy("WFP", "clerk_wfp");
      await expect(setSeatActive(db, leagueId, seat.id, false)).rejects.toThrow(
        /only commissioner/i,
      );
    });

    it("allows self-demotion once a second commissioner actually holds a seat", async () => {
      // This is the intended workflow: Mike signs in, then WFP steps down.
      const wfp = await occupy("WFP", "clerk_wfp");
      const sacks = await occupy("SACK", "clerk_sacks");

      // Both seats are already commissioner per the seed, and both are now held.
      await expect(setLeagueRole(db, leagueId, wfp.seat.id, "member")).resolves.toBeUndefined();

      const after = await db.query.teamManagers.findFirst({
        where: eq(schema.teamManagers.id, wfp.seat.id),
      });
      expect(after!.leagueRole).toBe("member");

      // And now Sacks is the last one, so he is protected in turn.
      await expect(setLeagueRole(db, leagueId, sacks.seat.id, "member")).rejects.toThrow(
        /only commissioner/i,
      );
    });

    it("does not count an unclaimed commissioner seat as cover", async () => {
      // SACK's seat is marked commissioner by the seed but nobody holds it, so
      // demoting the one live commissioner must still be refused.
      const { seat } = await occupy("WFP", "clerk_wfp");
      const sacksSeat = await seatFor("SACK");
      expect(sacksSeat.leagueRole).toBe("commissioner");
      expect(sacksSeat.userId).toBeNull();

      await expect(setLeagueRole(db, leagueId, seat.id, "member")).rejects.toThrow(
        /only commissioner/i,
      );
    });

    it("does not count a deactivated commissioner as cover", async () => {
      const wfp = await occupy("WFP", "clerk_wfp");
      const sacks = await occupy("SACK", "clerk_sacks");
      await db
        .update(schema.teamManagers)
        .set({ isActive: false })
        .where(eq(schema.teamManagers.id, sacks.seat.id));

      await expect(setLeagueRole(db, leagueId, wfp.seat.id, "member")).rejects.toThrow(
        /only commissioner/i,
      );
    });

    it("lets a plain member be demoted, unlinked or deactivated freely", async () => {
      const { seat } = await occupy("HULL", "clerk_tyler");
      await occupy("WFP", "clerk_wfp"); // a live commissioner exists

      await expect(setLeagueRole(db, leagueId, seat.id, "member")).resolves.toBeUndefined();
      await expect(setSeatActive(db, leagueId, seat.id, false)).resolves.toBeUndefined();
      await expect(unlinkSeat(db, leagueId, seat.id)).resolves.toBeUndefined();
    });

    it("can promote a new commissioner", async () => {
      const { seat } = await occupy("HULL", "clerk_tyler");
      await setLeagueRole(db, leagueId, seat.id, "commissioner");

      const after = await db.query.teamManagers.findFirst({
        where: eq(schema.teamManagers.id, seat.id),
      });
      expect(after!.leagueRole).toBe("commissioner");
    });
  });
});
