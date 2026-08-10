import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { seedLeague } from "@/db/seed";
import type { Db } from "@/db/types";
import { makeTestDb } from "@/test/db";

/**
 * The Clerk sign-in path is the only part of the system with no coverage, and
 * it is the first thing that runs for a real user. Everything else in the test
 * suite constructs an actor object directly and skips it entirely.
 *
 * Both `@/db` and `@/lib/league` are mocked through a mutable holder so each
 * test gets a fresh PGlite database. Getters are required because vi.mock
 * factories are hoisted above `testDb`'s assignment.
 */
let testDb: Db;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

vi.mock("@/lib/league", () => ({
  ESPN_LEAGUE_ID: "718396",
  currentSeasonYear: () => 2026,
  // Uncached on purpose: React's cache() would memoize league #1 across tests.
  getLeague: async () => {
    const league = await testDb.query.leagues.findFirst();
    if (!league) throw new Error("no league in test db");
    return league;
  },
}));

const mockAuth = vi.fn();
const mockCurrentUser = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => mockAuth(),
  currentUser: () => mockCurrentUser(),
}));

import { loadMembership } from "./membership";

/** Pretend a given Clerk identity is making the request. */
function signedInAs(opts: { clerkUserId: string; email: string | null; firstName?: string }) {
  mockAuth.mockResolvedValue({ userId: opts.clerkUserId });
  mockCurrentUser.mockResolvedValue({
    primaryEmailAddress: opts.email ? { emailAddress: opts.email } : null,
    firstName: opts.firstName ?? "Test",
    lastName: "Manager",
    username: null,
    imageUrl: null,
  });
}

function signedOut() {
  mockAuth.mockResolvedValue({ userId: null });
  mockCurrentUser.mockResolvedValue(null);
}

describe("loadMembership — Clerk sign-in and seat claiming", () => {
  beforeEach(async () => {
    ({ db: testDb } = await makeTestDb());
    await seedLeague(testDb, { espnLeagueId: "718396", currentYear: 2026 });
    mockAuth.mockReset();
    mockCurrentUser.mockReset();
  });

  const seatFor = async (abbrev: string) => {
    const team = await testDb.query.teams.findFirst({
      where: eq(schema.teams.abbrev, abbrev),
    });
    return testDb.query.teamManagers.findMany({
      where: eq(schema.teamManagers.teamId, team!.id),
    });
  };

  it("returns null when nobody is signed in", async () => {
    signedOut();
    expect(await loadMembership()).toBeNull();
  });

  it("claims the matching seat on first sign-in and reports commissioner", async () => {
    // wparker@uchicago.edu is seeded as WFP's invite email, and WFP is a commissioner.
    signedInAs({ clerkUserId: "user_wfp", email: "wparker@uchicago.edu", firstName: "William" });

    const membership = await loadMembership();

    expect(membership).not.toBeNull();
    expect(membership!.isUnlinked).toBe(false);
    expect(membership!.isCommissioner).toBe(true);

    const wfp = await testDb.query.teams.findFirst({ where: eq(schema.teams.abbrev, "WFP") });
    expect(membership!.teamIds).toEqual([wfp!.id]);
  });

  it("matches the invite email case-insensitively", async () => {
    signedInAs({ clerkUserId: "user_wfp", email: "WParker@UChicago.EDU" });
    const membership = await loadMembership();
    expect(membership!.isUnlinked).toBe(false);
  });

  it("leaves an unmatched email unlinked without silently claiming a seat", async () => {
    signedInAs({ clerkUserId: "user_stranger", email: "williamfparker@gmail.com" });

    const membership = await loadMembership();

    expect(membership!.isUnlinked).toBe(true);
    expect(membership!.teamIds).toEqual([]);
    expect(membership!.isCommissioner).toBe(false);

    // Crucially, no seat anywhere got attached to them.
    const claimed = await testDb.query.teamManagers.findMany();
    expect(claimed.every((s) => s.userId === null)).toBe(true);
  });

  it("creates the user row even when they are unlinked", async () => {
    signedInAs({ clerkUserId: "user_stranger", email: "nobody@example.com" });
    await loadMembership();

    const user = await testDb.query.users.findFirst({
      where: eq(schema.users.clerkUserId, "user_stranger"),
    });
    expect(user).toBeDefined();
    expect(user!.email).toBe("nobody@example.com");
  });

  it("is idempotent — signing in twice does not duplicate the user or the seat", async () => {
    signedInAs({ clerkUserId: "user_wfp", email: "wparker@uchicago.edu" });
    await loadMembership();
    await loadMembership();

    const users = await testDb.query.users.findMany({
      where: eq(schema.users.clerkUserId, "user_wfp"),
    });
    expect(users).toHaveLength(1);

    const seats = await seatFor("WFP");
    expect(seats).toHaveLength(1);
    expect(seats[0].userId).toBe(users[0].id);
  });

  it("does not let a second person steal an already-claimed seat", async () => {
    signedInAs({ clerkUserId: "user_wfp", email: "wparker@uchicago.edu" });
    const first = await loadMembership();

    // Someone else signs up later using the same invite address.
    signedInAs({ clerkUserId: "user_impostor", email: "wparker@uchicago.edu" });
    const second = await loadMembership();

    const seats = await seatFor("WFP");
    expect(seats[0].userId).toBe(first!.userId);
    expect(second!.userId).not.toBe(first!.userId);
    expect(second!.isUnlinked).toBe(true);
  });

  it("claims only one seat when both co-manager seats share an invite email", async () => {
    // BUES has two ESPN identities: "Rob Buesing" and "Robert Buesing". One
    // human, two seats — so both can legitimately carry the same address.
    const seats = await seatFor("BUES");
    expect(seats).toHaveLength(2);

    await testDb
      .update(schema.teamManagers)
      .set({ inviteEmail: "buesing@example.com" })
      .where(eq(schema.teamManagers.teamId, seats[0].teamId));

    signedInAs({ clerkUserId: "user_bues", email: "buesing@example.com" });
    const membership = await loadMembership();

    // Exactly one franchise, therefore exactly one ballot.
    expect(membership!.teamIds).toHaveLength(1);
    expect(membership!.teamIds[0]).toBe(seats[0].teamId);

    // The second seat is left unclaimed for the actual second co-manager.
    const after = await seatFor("BUES");
    expect(after.filter((s) => s.userId !== null)).toHaveLength(1);
    expect(after.filter((s) => s.userId === null)).toHaveLength(1);
  });

  it("lets a genuine second co-manager claim the remaining seat", async () => {
    const seats = await seatFor("BUES");
    await testDb
      .update(schema.teamManagers)
      .set({ inviteEmail: "rob@example.com" })
      .where(eq(schema.teamManagers.id, seats[0].id));
    await testDb
      .update(schema.teamManagers)
      .set({ inviteEmail: "robert@example.com" })
      .where(eq(schema.teamManagers.id, seats[1].id));

    signedInAs({ clerkUserId: "user_rob", email: "rob@example.com" });
    const rob = await loadMembership();
    signedInAs({ clerkUserId: "user_robert", email: "robert@example.com" });
    const robert = await loadMembership();

    // Two people, both on BUES — the schema allows it because the unique index
    // is on (team_id, user_id), not on team_id alone.
    expect(rob!.teamIds).toEqual([seats[0].teamId]);
    expect(robert!.teamIds).toEqual([seats[0].teamId]);
    expect(rob!.userId).not.toBe(robert!.userId);
  });

  it("does not crash when two Clerk accounts share an email address", async () => {
    // Clerk normally prevents this, but email is data Clerk owns and can change.
    // A unique index on users.email would turn this into a 500 on sign-in.
    signedInAs({ clerkUserId: "user_a", email: "shared@example.com" });
    const a = await loadMembership();
    signedInAs({ clerkUserId: "user_b", email: "shared@example.com" });
    const b = await loadMembership();

    expect(a!.userId).not.toBe(b!.userId);
    expect(b!.clerkUserId).toBe("user_b");
  });

  it("tolerates a Clerk account with no email address", async () => {
    signedInAs({ clerkUserId: "user_noemail", email: null });
    const membership = await loadMembership();
    expect(membership!.isUnlinked).toBe(true);
  });

  it("refreshes the display name on subsequent sign-ins", async () => {
    signedInAs({ clerkUserId: "user_wfp", email: "wparker@uchicago.edu", firstName: "William" });
    await loadMembership();

    signedInAs({ clerkUserId: "user_wfp", email: "wparker@uchicago.edu", firstName: "Will" });
    const membership = await loadMembership();

    expect(membership!.displayName).toBe("Will Manager");
  });
});
