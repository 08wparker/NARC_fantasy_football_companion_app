"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import {
  cancelTrade,
  confirmTrade,
  createTrade,
  rejectTrade,
  voidTrade,
} from "@/db/trade-service";
import type { TradeAssetInput } from "@/db/trade-logic";
import { requireCommissioner, requireLeagueMembership } from "@/lib/auth/membership";
import { getLeague } from "@/lib/league";

/**
 * Every action re-authorizes from scratch.
 *
 * Server Functions are dispatched as POSTs to whatever route they're used on
 * and are reachable directly, so `proxy.ts` does NOT protect them. The auth
 * check has to live here, in the function itself.
 */

const assetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft_pick"),
    fromTeamId: z.number().int(),
    toTeamId: z.number().int(),
    draftPickId: z.number().int(),
  }),
  z.object({
    kind: z.literal("player"),
    fromTeamId: z.number().int(),
    toTeamId: z.number().int(),
    playerId: z.number().int(),
  }),
  z.object({
    kind: z.literal("keeper_right"),
    fromTeamId: z.number().int(),
    toTeamId: z.number().int(),
    playerId: z.number().int(),
    seasonId: z.number().int(),
  }),
  z.object({
    kind: z.literal("keeper_slot"),
    fromTeamId: z.number().int(),
    toTeamId: z.number().int(),
    seasonId: z.number().int(),
    slotCount: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal("draft_slot_swap"),
    fromTeamId: z.number().int(),
    toTeamId: z.number().int(),
    seasonId: z.number().int(),
  }),
]);

const createSchema = z.object({
  loggedByTeamId: z.number().int(),
  assets: z.array(assetSchema).min(1),
  agreedOn: z.string().optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
});

export type ActionResult = { ok: true; warnings?: string[] } | { ok: false; error: string };

function fail(error: unknown): ActionResult {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

export async function logTradeAction(raw: unknown): Promise<ActionResult> {
  try {
    const membership = await requireLeagueMembership();
    const league = await getLeague();
    const input = createSchema.parse(raw);

    const { warnings } = await createTrade(db, membership, {
      leagueId: league.id,
      loggedByTeamId: input.loggedByTeamId,
      assets: input.assets as TradeAssetInput[],
      agreedOn: input.agreedOn ? new Date(input.agreedOn) : null,
      note: input.note ?? null,
    });

    revalidatePath("/trades");
    revalidatePath("/");
    return { ok: true, warnings: warnings.map((w) => w.message) };
  } catch (error) {
    return fail(error);
  }
}

export async function confirmTradeAction(tradeId: number): Promise<ActionResult> {
  try {
    const membership = await requireLeagueMembership();
    const { warnings } = await confirmTrade(db, membership, tradeId);

    revalidatePath("/trades");
    revalidatePath("/draft-board");
    revalidatePath("/");
    return { ok: true, warnings: warnings.map((w) => w.message) };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectTradeAction(tradeId: number, note?: string): Promise<ActionResult> {
  try {
    const membership = await requireLeagueMembership();
    await rejectTrade(db, membership, tradeId, note);
    revalidatePath("/trades");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function cancelTradeAction(tradeId: number, note?: string): Promise<ActionResult> {
  try {
    const membership = await requireLeagueMembership();
    await cancelTrade(db, membership, tradeId, note);
    revalidatePath("/trades");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function voidTradeAction(tradeId: number, reason: string): Promise<ActionResult> {
  try {
    // Commissioner-only, enforced here rather than by any route matcher.
    const membership = await requireCommissioner();
    const { warnings } = await voidTrade(db, membership, tradeId, reason);

    revalidatePath("/trades");
    revalidatePath("/draft-board");
    revalidatePath("/");
    return { ok: true, warnings: warnings.map((w) => w.message) };
  } catch (error) {
    return fail(error);
  }
}
