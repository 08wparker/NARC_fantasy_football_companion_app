import { and, eq, sql } from "drizzle-orm";

import * as schema from "./schema";
import type { Db, DbOrTx } from "./types";

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

type Actor = { userId: number; teamIds: number[]; isCommissioner: boolean };

export type Tally = {
  yes: number;
  no: number;
  abstain: number;
  cast: number;
  eligible: number;
  requiredYes: number;
  notVoted: number;
  passed: boolean;
  /** True when the remaining ballots cannot possibly reach the threshold. */
  mathematicallyFailed: boolean;
};

/**
 * Count a proposal.
 *
 * Two semantics the league will argue about, so they're explicit here:
 *
 *  1. The denominator is the eligible franchise count snapshotted at open time
 *     (12), NOT ballots cast. Abstaining and not voting therefore have the same
 *     effect as a no. The UI says so out loud.
 *  2. The pass check is integer cross-multiplication — `yes * denom >= eligible
 *     * numer` — so 8/12 against a 2/3 threshold is exact, with no float
 *     rounding deciding a rule change.
 */
export function tallyVotes(
  votes: Array<{ choice: "yes" | "no" | "abstain" }>,
  opts: { eligible: number; numerator: number; denominator: number },
): Tally {
  const yes = votes.filter((v) => v.choice === "yes").length;
  const no = votes.filter((v) => v.choice === "no").length;
  const abstain = votes.filter((v) => v.choice === "abstain").length;
  const cast = votes.length;
  const { eligible, numerator, denominator } = opts;

  const requiredYes = Math.ceil((eligible * numerator) / denominator);
  const passed = yes * denominator >= eligible * numerator;
  // Even if every remaining franchise votes yes, can it still reach the bar?
  const bestCaseYes = yes + (eligible - cast);
  const mathematicallyFailed = bestCaseYes * denominator < eligible * numerator;

  return {
    yes,
    no,
    abstain,
    cast,
    eligible,
    requiredYes,
    notVoted: Math.max(0, eligible - cast),
    passed,
    mathematicallyFailed,
  };
}

export async function getTally(db: DbOrTx, proposalId: number): Promise<Tally> {
  const proposal = await db.query.proposals.findFirst({
    where: eq(schema.proposals.id, proposalId),
    with: { votes: true },
  });
  if (!proposal) throw new ProposalError("Proposal not found.");

  // Before a proposal opens there is no snapshot, so fall back to live team count.
  let eligible = proposal.eligibleVoterCount;
  if (eligible == null) {
    const teams = await db.query.teams.findMany({
      where: eq(schema.teams.leagueId, proposal.leagueId),
    });
    eligible = teams.length;
  }

  return tallyVotes(proposal.votes, {
    eligible,
    numerator: proposal.thresholdNumerator,
    denominator: proposal.thresholdDenominator,
  });
}

/** Anyone in the league can draft a proposal. It is not votable until opened. */
export async function createProposal(
  db: Db,
  actor: Actor,
  input: {
    leagueId: number;
    title: string;
    body: string;
    thresholdNumerator?: number;
    thresholdDenominator?: number;
  },
) {
  if (!input.title.trim()) throw new ProposalError("A proposal needs a title.");
  if (!input.body.trim()) throw new ProposalError("A proposal needs a description.");

  const [proposal] = await db
    .insert(schema.proposals)
    .values({
      leagueId: input.leagueId,
      title: input.title.trim(),
      body: input.body.trim(),
      status: "draft",
      proposedByUserId: actor.userId,
      proposedByTeamId: actor.teamIds[0] ?? null,
      thresholdNumerator: input.thresholdNumerator ?? 2,
      thresholdDenominator: input.thresholdDenominator ?? 3,
    })
    .returning();

  return proposal;
}

/**
 * Commissioner moves a draft onto the ballot.
 *
 * The eligible-voter count and threshold are frozen here so the pass math stays
 * deterministic — a proposal opened at 12 teams cannot retroactively re-pass
 * because a team folded in November.
 */
export async function openVoting(
  db: Db,
  actor: Actor,
  proposalId: number,
  opts: { closesAt: Date },
) {
  if (!actor.isCommissioner) {
    throw new ProposalError("Only the commissioner can open voting.");
  }

  const proposal = await db.query.proposals.findFirst({
    where: eq(schema.proposals.id, proposalId),
  });
  if (!proposal) throw new ProposalError("Proposal not found.");
  if (proposal.status !== "draft") {
    throw new ProposalError(`Only a draft proposal can be opened (this one is ${proposal.status}).`);
  }
  if (opts.closesAt.getTime() <= Date.now()) {
    throw new ProposalError("The voting deadline must be in the future.");
  }

  const teams = await db.query.teams.findMany({
    where: eq(schema.teams.leagueId, proposal.leagueId),
  });

  const [updated] = await db
    .update(schema.proposals)
    .set({
      status: "open",
      openedAt: new Date(),
      openedByUserId: actor.userId,
      closesAt: opts.closesAt,
      eligibleVoterCount: teams.length,
    })
    .where(eq(schema.proposals.id, proposalId))
    .returning();

  return updated;
}

/**
 * Cast or change a franchise's ballot.
 *
 * Keyed on team, not user: the BUES franchise has two ESPN identities, and one
 * franchise gets one vote. `castByUserId` records which co-manager acted.
 */
export async function castVote(
  db: Db,
  actor: Actor,
  input: { proposalId: number; teamId: number; choice: "yes" | "no" | "abstain" },
) {
  const proposal = await db.query.proposals.findFirst({
    where: eq(schema.proposals.id, input.proposalId),
  });
  if (!proposal) throw new ProposalError("Proposal not found.");
  if (proposal.status !== "open") {
    throw new ProposalError("Voting is not open on this proposal.");
  }
  if (proposal.closesAt && proposal.closesAt.getTime() <= Date.now()) {
    throw new ProposalError("Voting has closed on this proposal.");
  }
  if (!actor.teamIds.includes(input.teamId)) {
    throw new ProposalError("You can only vote for a franchise you manage.");
  }

  await db
    .insert(schema.votes)
    .values({
      proposalId: input.proposalId,
      teamId: input.teamId,
      choice: input.choice,
      castByUserId: actor.userId,
    })
    .onConflictDoUpdate({
      target: [schema.votes.proposalId, schema.votes.teamId],
      set: { choice: input.choice, castByUserId: actor.userId, updatedAt: new Date() },
    });
}

/**
 * Close the ballot and freeze the outcome.
 *
 * The terminal status is stored rather than always derived, so a later edit to
 * the votes table cannot silently rewrite a decided rule change.
 */
export async function closeVoting(db: Db, actor: Actor, proposalId: number) {
  if (!actor.isCommissioner) {
    throw new ProposalError("Only the commissioner can close voting.");
  }

  const proposal = await db.query.proposals.findFirst({
    where: eq(schema.proposals.id, proposalId),
  });
  if (!proposal) throw new ProposalError("Proposal not found.");
  if (proposal.status !== "open") {
    throw new ProposalError(`Only an open proposal can be closed (this one is ${proposal.status}).`);
  }

  const tally = await getTally(db, proposalId);
  const [updated] = await db
    .update(schema.proposals)
    .set({ status: tally.passed ? "passed" : "failed", closedAt: new Date() })
    .where(eq(schema.proposals.id, proposalId))
    .returning();

  return { proposal: updated, tally };
}

export async function withdrawProposal(db: Db, actor: Actor, proposalId: number) {
  const proposal = await db.query.proposals.findFirst({
    where: eq(schema.proposals.id, proposalId),
  });
  if (!proposal) throw new ProposalError("Proposal not found.");
  if (proposal.proposedByUserId !== actor.userId && !actor.isCommissioner) {
    throw new ProposalError("Only the author or the commissioner can withdraw a proposal.");
  }
  if (proposal.status !== "draft" && proposal.status !== "open") {
    throw new ProposalError("This proposal has already been decided.");
  }

  await db
    .update(schema.proposals)
    .set({ status: "withdrawn", closedAt: new Date() })
    .where(eq(schema.proposals.id, proposalId));
}

/** Auto-close any open proposal whose deadline has passed. */
export async function closeExpiredProposals(db: Db, leagueId: number) {
  const expired = await db.query.proposals.findMany({
    where: and(
      eq(schema.proposals.leagueId, leagueId),
      eq(schema.proposals.status, "open"),
      sql`${schema.proposals.closesAt} <= now()`,
    ),
  });

  const closed = [];
  for (const p of expired) {
    const tally = await getTally(db, p.id);
    const [updated] = await db
      .update(schema.proposals)
      .set({ status: tally.passed ? "passed" : "failed", closedAt: new Date() })
      .where(eq(schema.proposals.id, p.id))
      .returning();
    closed.push({ proposal: updated, tally });
  }
  return closed;
}
