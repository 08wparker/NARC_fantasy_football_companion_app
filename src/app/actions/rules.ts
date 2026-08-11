"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { addRule, deleteRule, moveRule, updateRule } from "@/db/rules-service";
import { requireCommissioner } from "@/lib/auth/membership";
import { getLeague } from "@/lib/league";

import type { ActionResult } from "./trades";

function fail(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : "Something went wrong." };
}

function done(): ActionResult {
  revalidatePath("/rules");
  return { ok: true };
}

const body = z.string().min(1).max(2000);
const id = z.number().int().positive();

export async function addRuleAction(rawBody: string): Promise<ActionResult> {
  try {
    const membership = await requireCommissioner();
    const league = await getLeague();
    await addRule(db, league.id, body.parse(rawBody), { createdByUserId: membership.userId });
    return done();
  } catch (error) {
    return fail(error);
  }
}

export async function updateRuleAction(ruleId: number, rawBody: string): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    await updateRule(db, league.id, id.parse(ruleId), body.parse(rawBody));
    return done();
  } catch (error) {
    return fail(error);
  }
}

export async function deleteRuleAction(ruleId: number): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    await deleteRule(db, league.id, id.parse(ruleId));
    return done();
  } catch (error) {
    return fail(error);
  }
}

export async function moveRuleAction(
  ruleId: number,
  direction: "up" | "down",
): Promise<ActionResult> {
  try {
    await requireCommissioner();
    const league = await getLeague();
    await moveRule(db, league.id, id.parse(ruleId), z.enum(["up", "down"]).parse(direction));
    return done();
  } catch (error) {
    return fail(error);
  }
}
