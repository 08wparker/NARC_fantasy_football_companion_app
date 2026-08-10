import { auth, currentUser } from "@clerk/nextjs/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cache } from "react";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { getLeague } from "@/lib/league";

export type Membership = {
  userId: number;
  clerkUserId: string;
  displayName: string;
  /** Franchises this person manages. Usually one; co-managers are supported. */
  teamIds: number[];
  isCommissioner: boolean;
  /** True when signed in but not yet linked to a franchise. */
  isUnlinked: boolean;
};

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "NotSignedInError";
  }
}

export class NotALeagueMemberError extends Error {
  constructor() {
    super("Signed in, but not linked to a franchise in this league");
    this.name = "NotALeagueMemberError";
  }
}

/**
 * Upsert the Clerk user into our `users` table and, if they have an unclaimed
 * manager seat matching their email, claim it.
 *
 * The claim-by-email step is what lets the commissioner pre-populate the whole
 * league (and backfill years of pick trades) before anyone else signs up:
 * `team_managers.user_id` stays NULL until its human arrives.
 */
async function syncClerkUser() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;

  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;
  const displayName =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") ||
    clerkUser?.username ||
    email ||
    "Unknown manager";

  const [user] = await db
    .insert(schema.users)
    .values({
      clerkUserId,
      email,
      displayName,
      imageUrl: clerkUser?.imageUrl ?? null,
    })
    .onConflictDoUpdate({
      target: schema.users.clerkUserId,
      set: { email, displayName, imageUrl: clerkUser?.imageUrl ?? null },
    })
    .returning();

  if (email) {
    const league = await getLeague();

    // Claim unclaimed seats whose invite email matches. Case-insensitive,
    // because nobody types their email the same way twice.
    const candidates = await db.query.teamManagers.findMany({
      where: and(
        eq(schema.teamManagers.leagueId, league.id),
        isNull(schema.teamManagers.userId),
        sql`lower(${schema.teamManagers.inviteEmail}) = ${email}`,
      ),
      orderBy: (m, { asc }) => [asc(m.id)],
    });

    /**
     * At most ONE seat per franchise.
     *
     * A co-managed team has several seats (BUES has two, because ESPN lists
     * "Rob Buesing" and "Robert Buesing" as separate members). If both carry
     * the same invite email — one human, two ESPN identities — claiming both
     * would violate team_managers_team_user_uq and 500 the sign-in. Taking the
     * first seat per team also keeps the franchise on a single ballot, which is
     * the invariant the whole voting design rests on.
     */
    const seenTeams = new Set<number>();
    const toClaim = candidates.filter((seat) => {
      if (seenTeams.has(seat.teamId)) return false;
      seenTeams.add(seat.teamId);
      return true;
    });

    if (toClaim.length > 0) {
      await db
        .update(schema.teamManagers)
        .set({ userId: user.id })
        .where(
          inArray(
            schema.teamManagers.id,
            toClaim.map((s) => s.id),
          ),
        );
    }
  }

  return user;
}

/**
 * The single authorization entry point. Every page, server action and route
 * handler that touches league data calls this — never a path-based check,
 * because Server Functions bypass path matching entirely.
 *
 * Returns null when not signed in, so callers can choose between redirecting
 * and rendering a public view.
 */
export async function loadMembership(): Promise<Membership | null> {
  const user = await syncClerkUser();
  if (!user) return null;

  const league = await getLeague();
  const seats = await db.query.teamManagers.findMany({
    where: and(
      eq(schema.teamManagers.leagueId, league.id),
      eq(schema.teamManagers.userId, user.id),
      eq(schema.teamManagers.isActive, true),
    ),
  });

  return {
    userId: user.id,
    clerkUserId: user.clerkUserId,
    displayName: user.displayName ?? "Unknown manager",
    teamIds: seats.map((s) => s.teamId),
    isCommissioner: seats.some((s) => s.leagueRole === "commissioner"),
    isUnlinked: seats.length === 0,
  };
}

/**
 * Request-scoped memo of loadMembership(). Split so tests can exercise the
 * uncached implementation — React's cache() has no request scope under vitest,
 * and a memoized result would leak across tests that each build a fresh database.
 */
export const getMembership = cache(loadMembership);

/** Throws unless signed in AND linked to at least one franchise. */
export async function requireLeagueMembership(): Promise<Membership> {
  const membership = await getMembership();
  if (!membership) throw new NotSignedInError();
  if (membership.isUnlinked) throw new NotALeagueMemberError();
  return membership;
}

export async function requireCommissioner(): Promise<Membership> {
  const membership = await requireLeagueMembership();
  if (!membership.isCommissioner) {
    throw new Error("This action requires the league commissioner.");
  }
  return membership;
}

/**
 * Authorization is always "does this user hold a seat for team X", never
 * "is this user team X". That indirection is what makes co-managers free.
 */
export function managesTeam(membership: Membership, teamId: number) {
  return membership.teamIds.includes(teamId);
}
