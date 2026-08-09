import { auth, currentUser } from "@clerk/nextjs/server";
import { and, eq, isNull, sql } from "drizzle-orm";
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
    // Claim an unclaimed seat whose invite email matches. Case-insensitive,
    // because nobody types their email the same way twice.
    await db
      .update(schema.teamManagers)
      .set({ userId: user.id })
      .where(
        and(
          eq(schema.teamManagers.leagueId, league.id),
          isNull(schema.teamManagers.userId),
          sql`lower(${schema.teamManagers.inviteEmail}) = ${email}`,
        ),
      );
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
export const getMembership = cache(async (): Promise<Membership | null> => {
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
});

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
