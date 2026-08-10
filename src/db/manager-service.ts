import { and, eq, isNotNull } from "drizzle-orm";

import * as schema from "./schema";
import type { Db } from "./types";

export class ManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerError";
  }
}

/**
 * Seats that actually confer commissioner powers right now: the role is only
 * real if a live human holds the seat, so an unclaimed or deactivated
 * commissioner seat does not count.
 *
 * This mirrors how loadMembership() computes isCommissioner. If the two ever
 * disagree, the guard below stops protecting anything.
 */
async function heldCommissionerSeats(db: Db, leagueId: number) {
  return db.query.teamManagers.findMany({
    where: and(
      eq(schema.teamManagers.leagueId, leagueId),
      eq(schema.teamManagers.leagueRole, "commissioner"),
      eq(schema.teamManagers.isActive, true),
      isNotNull(schema.teamManagers.userId),
    ),
  });
}

/**
 * Refuse any change that would leave the league with nobody able to void a
 * trade or open a ballot.
 *
 * This is load-bearing rather than defensive: handing the role to Mike Sacks and
 * then dropping your own is the intended workflow, and doing those two steps in
 * the wrong order would otherwise lock every manager out permanently, with no
 * in-app way back.
 */
async function assertNotLastCommissioner(db: Db, leagueId: number, seatId: number) {
  const held = await heldCommissionerSeats(db, leagueId);
  const isOneOfThem = held.some((s) => s.id === seatId);
  if (isOneOfThem && held.length <= 1) {
    throw new ManagerError(
      "This is the league's only commissioner. Promote someone else first, " +
        "otherwise nobody could void a trade or open a ballot.",
    );
  }
}

async function seatInLeague(db: Db, leagueId: number, seatId: number) {
  const seat = await db.query.teamManagers.findFirst({
    where: and(eq(schema.teamManagers.id, seatId), eq(schema.teamManagers.leagueId, leagueId)),
    with: { team: true },
  });
  if (!seat) throw new ManagerError("That manager seat does not exist in this league.");
  return seat;
}

/** How everyone other than the first commissioner gets in. */
export async function setInviteEmail(
  db: Db,
  leagueId: number,
  seatId: number,
  email: string | null,
) {
  await seatInLeague(db, leagueId, seatId);
  const normalized = email?.trim().toLowerCase() || null;

  if (normalized && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new ManagerError(`"${email}" does not look like an email address.`);
  }

  await db
    .update(schema.teamManagers)
    .set({ inviteEmail: normalized })
    .where(eq(schema.teamManagers.id, seatId));
}

/**
 * Attach an already-signed-up user to a seat.
 *
 * The rescue path for someone whose Clerk email never matched an invite — they
 * sign in, land unlinked, and the commissioner points them at the right seat.
 */
export async function assignUserToSeat(db: Db, leagueId: number, seatId: number, userId: number) {
  const seat = await seatInLeague(db, leagueId, seatId);

  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new ManagerError("That user does not exist.");

  if (seat.userId === userId) return; // already there, nothing to do

  // (team_id, user_id) is unique, so one person cannot hold two seats on the
  // same franchise — that would be two ballots.
  const existing = await db.query.teamManagers.findFirst({
    where: and(eq(schema.teamManagers.teamId, seat.teamId), eq(schema.teamManagers.userId, userId)),
  });
  if (existing) {
    throw new ManagerError(
      `${user.displayName ?? "That user"} already holds a seat on ${seat.team.abbrev}.`,
    );
  }

  if (seat.userId !== null) {
    // Replacing an occupant could strip the last commissioner.
    await assertNotLastCommissioner(db, leagueId, seatId);
  }

  await db
    .update(schema.teamManagers)
    .set({ userId })
    .where(eq(schema.teamManagers.id, seatId));
}

export async function unlinkSeat(db: Db, leagueId: number, seatId: number) {
  await seatInLeague(db, leagueId, seatId);
  await assertNotLastCommissioner(db, leagueId, seatId);

  await db
    .update(schema.teamManagers)
    .set({ userId: null })
    .where(eq(schema.teamManagers.id, seatId));
}

export async function setLeagueRole(
  db: Db,
  leagueId: number,
  seatId: number,
  role: "member" | "commissioner",
) {
  await seatInLeague(db, leagueId, seatId);
  if (role === "member") {
    await assertNotLastCommissioner(db, leagueId, seatId);
  }

  await db
    .update(schema.teamManagers)
    .set({ leagueRole: role })
    .where(eq(schema.teamManagers.id, seatId));
}

export async function setSeatActive(db: Db, leagueId: number, seatId: number, isActive: boolean) {
  await seatInLeague(db, leagueId, seatId);
  if (!isActive) {
    await assertNotLastCommissioner(db, leagueId, seatId);
  }

  await db
    .update(schema.teamManagers)
    .set({ isActive })
    .where(eq(schema.teamManagers.id, seatId));
}
