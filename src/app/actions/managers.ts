"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import {
  assignUserToSeat,
  setInviteEmail,
  setLeagueRole,
  setSeatActive,
  unlinkSeat,
} from "@/db/manager-service";
import { requireCommissioner } from "@/lib/auth/membership";
import { getLeague } from "@/lib/league";

import type { ActionResult } from "./trades";

/**
 * Seat administration. Every action re-authorizes as commissioner here, in the
 * function itself — Server Functions are dispatched as POSTs to whatever route
 * they're used on and are directly reachable, so proxy.ts does not protect them.
 */

function fail(error: unknown): ActionResult {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

function done(): ActionResult {
  revalidatePath("/commissioner");
  revalidatePath("/");
  return { ok: true };
}

const seatId = z.number().int().positive();

export async function setInviteEmailAction(
  rawSeatId: number,
  rawEmail: string | null,
): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    await setInviteEmail(db, league.id, seatId.parse(rawSeatId), rawEmail);
    return done();
  } catch (error) {
    return fail(error);
  }
}

export async function assignUserToSeatAction(
  rawSeatId: number,
  rawUserId: number,
): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    await assignUserToSeat(db, league.id, seatId.parse(rawSeatId), seatId.parse(rawUserId));
    return done();
  } catch (error) {
    return fail(error);
  }
}

export async function unlinkSeatAction(rawSeatId: number): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    await unlinkSeat(db, league.id, seatId.parse(rawSeatId));
    return done();
  } catch (error) {
    return fail(error);
  }
}

export async function setLeagueRoleAction(
  rawSeatId: number,
  rawRole: "member" | "commissioner",
): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    const role = z.enum(["member", "commissioner"]).parse(rawRole);
    await setLeagueRole(db, league.id, seatId.parse(rawSeatId), role);
    return done();
  } catch (error) {
    return fail(error);
  }
}

export async function setSeatActiveAction(
  rawSeatId: number,
  isActive: boolean,
): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    await setSeatActive(db, league.id, seatId.parse(rawSeatId), z.boolean().parse(isActive));
    return done();
  } catch (error) {
    return fail(error);
  }
}
