"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import {
  castVote,
  closeVoting,
  createProposal,
  openVoting,
  withdrawProposal,
} from "@/db/proposal-service";
import { requireCommissioner, requireLeagueMembership } from "@/lib/auth/membership";
import { getLeague } from "@/lib/league";

import type { ActionResult } from "./trades";

function fail(error: unknown): ActionResult {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

const createSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(1).max(10_000),
  thresholdNumerator: z.number().int().min(1).optional(),
  thresholdDenominator: z.number().int().min(1).optional(),
});

export async function createProposalAction(raw: unknown): Promise<ActionResult> {
  try {
    const membership = await requireLeagueMembership();
    const league = await getLeague();
    const input = createSchema.parse(raw);

    await createProposal(db, membership, { leagueId: league.id, ...input });
    revalidatePath("/rules");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function openVotingAction(
  proposalId: number,
  closesAtIso: string,
): Promise<ActionResult> {
  try {
    const membership = await requireCommissioner();
    await openVoting(db, membership, proposalId, { closesAt: new Date(closesAtIso) });
    revalidatePath("/rules");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function castVoteAction(
  proposalId: number,
  teamId: number,
  choice: "yes" | "no" | "abstain",
): Promise<ActionResult> {
  try {
    const membership = await requireLeagueMembership();
    await castVote(db, membership, { proposalId, teamId, choice });
    revalidatePath("/rules");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function closeVotingAction(proposalId: number): Promise<ActionResult> {
  try {
    const membership = await requireCommissioner();
    await closeVoting(db, membership, proposalId);
    revalidatePath("/rules");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function withdrawProposalAction(proposalId: number): Promise<ActionResult> {
  try {
    const membership = await requireLeagueMembership();
    await withdrawProposal(db, membership, proposalId);
    revalidatePath("/rules");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
