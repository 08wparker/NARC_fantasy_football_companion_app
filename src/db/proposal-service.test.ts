import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  castVote,
  closeVoting,
  createProposal,
  getTally,
  openVoting,
  tallyVotes,
  withdrawProposal,
} from "@/db/proposal-service";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";
import { makeTestDb, seedTestLeague } from "@/test/db";

describe("tallyVotes (pure)", () => {
  const twoThirdsOf12 = { eligible: 12, numerator: 2, denominator: 3 };
  const yes = (n: number) => Array.from({ length: n }, () => ({ choice: "yes" as const }));

  it("requires 8 of 12 for a 2/3 threshold", () => {
    expect(tallyVotes([], twoThirdsOf12).requiredYes).toBe(8);
  });

  it("passes at exactly 8 yes and fails at 7", () => {
    expect(tallyVotes(yes(8), twoThirdsOf12).passed).toBe(true);
    expect(tallyVotes(yes(7), twoThirdsOf12).passed).toBe(false);
  });

  it("treats abstentions and non-votes as equivalent to no", () => {
    const withAbstain = tallyVotes(
      [...yes(7), { choice: "abstain" as const }, ...Array(4).fill({ choice: "no" as const })],
      twoThirdsOf12,
    );
    expect(withAbstain.passed).toBe(false);
    // 7 yes and nothing else is the same outcome
    expect(tallyVotes(yes(7), twoThirdsOf12).passed).toBe(false);
  });

  it("counts franchises that have not voted", () => {
    const t = tallyVotes(yes(5), twoThirdsOf12);
    expect(t.cast).toBe(5);
    expect(t.notVoted).toBe(7);
  });

  it("detects when a proposal can no longer pass", () => {
    // 5 no votes means at most 7 yes remain reachable, short of 8.
    const votes = Array(5).fill({ choice: "no" as const });
    expect(tallyVotes(votes, twoThirdsOf12).mathematicallyFailed).toBe(true);

    // 4 no votes still leaves 8 reachable.
    expect(
      tallyVotes(Array(4).fill({ choice: "no" as const }), twoThirdsOf12).mathematicallyFailed,
    ).toBe(false);
  });

  it("is exact for thresholds that would round badly in floating point", () => {
    // 7/10 with a 7/10 threshold must pass on the nose.
    expect(tallyVotes(yes(7), { eligible: 10, numerator: 7, denominator: 10 }).passed).toBe(true);
    expect(tallyVotes(yes(6), { eligible: 10, numerator: 7, denominator: 10 }).passed).toBe(false);
    // simple majority of 12
    expect(tallyVotes(yes(6), { eligible: 12, numerator: 1, denominator: 2 }).passed).toBe(true);
    expect(tallyVotes(yes(5), { eligible: 12, numerator: 1, denominator: 2 }).passed).toBe(false);
  });
});

describe("proposal service", () => {
  let db: Db;
  let fx: Awaited<ReturnType<typeof seedTestLeague>>;
  let member: { userId: number; teamIds: number[]; isCommissioner: boolean };
  let commish: typeof member;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    fx = await seedTestLeague(db, { year: 2027, rounds: 2 });
    member = { userId: fx.user.id, teamIds: [fx.team.WFP.id], isCommissioner: false };
    commish = { userId: fx.user.id, teamIds: [fx.team.SACK.id], isCommissioner: true };
  });

  const draft = () =>
    createProposal(db, member, {
      leagueId: fx.league.id,
      title: "Three keepers instead of two",
      body: "Self explanatory.",
    });

  const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

  it("lets any member draft a proposal, not yet votable", async () => {
    const p = await draft();
    expect(p.status).toBe("draft");
    await expect(
      castVote(db, member, { proposalId: p.id, teamId: fx.team.WFP.id, choice: "yes" }),
    ).rejects.toThrow(/not open/i);
  });

  it("only lets the commissioner open voting", async () => {
    const p = await draft();
    await expect(openVoting(db, member, p.id, { closesAt: tomorrow() })).rejects.toThrow(
      /commissioner/i,
    );
    const opened = await openVoting(db, commish, p.id, { closesAt: tomorrow() });
    expect(opened.status).toBe("open");
  });

  it("snapshots the eligible voter count when opening", async () => {
    const p = await draft();
    const opened = await openVoting(db, commish, p.id, { closesAt: tomorrow() });
    expect(opened.eligibleVoterCount).toBe(12);
  });

  it("keeps the pass bar fixed even if the league changes size mid-ballot", async () => {
    const p = await draft();
    await openVoting(db, commish, p.id, { closesAt: tomorrow() });

    // Two expansion franchises join after the ballot opened.
    await db.insert(schema.teams).values([
      { leagueId: fx.league.id, espnTeamId: 13, abbrev: "NEW1", name: "Expansion One" },
      { leagueId: fx.league.id, espnTeamId: 14, abbrev: "NEW2", name: "Expansion Two" },
    ]);

    const tally = await getTally(db, p.id);
    expect(tally.eligible).toBe(12); // the snapshot, not the live count of 14
    expect(tally.requiredYes).toBe(8); // not 10
  });

  it("uses the live team count for a proposal that has not opened yet", async () => {
    const p = await draft();
    const tally = await getTally(db, p.id);
    expect(tally.eligible).toBe(12);
    expect(tally.requiredYes).toBe(8);
  });

  it("rejects a deadline in the past", async () => {
    const p = await draft();
    await expect(
      openVoting(db, commish, p.id, { closesAt: new Date(Date.now() - 1000) }),
    ).rejects.toThrow(/future/i);
  });

  it("records one ballot per franchise and lets it be changed", async () => {
    const p = await draft();
    await openVoting(db, commish, p.id, { closesAt: tomorrow() });

    await castVote(db, member, { proposalId: p.id, teamId: fx.team.WFP.id, choice: "yes" });
    expect((await getTally(db, p.id)).yes).toBe(1);

    // Same franchise changes its mind — an update, not a second ballot.
    await castVote(db, member, { proposalId: p.id, teamId: fx.team.WFP.id, choice: "no" });
    const tally = await getTally(db, p.id);
    expect(tally.yes).toBe(0);
    expect(tally.no).toBe(1);
    expect(tally.cast).toBe(1);
  });

  it("refuses a vote for a franchise you do not manage", async () => {
    const p = await draft();
    await openVoting(db, commish, p.id, { closesAt: tomorrow() });
    await expect(
      castVote(db, member, { proposalId: p.id, teamId: fx.team.DICK.id, choice: "yes" }),
    ).rejects.toThrow(/franchise you manage/i);
  });

  it("passes at 8 of 12 and freezes the result", async () => {
    const p = await draft();
    await openVoting(db, commish, p.id, { closesAt: tomorrow() });

    const abbrevs = ["SACK", "BUES", "WFP", "NOVA", "DICK", "MAYE", "BYRN", "HULL"] as const;
    for (const abbrev of abbrevs) {
      await castVote(
        db,
        { userId: fx.user.id, teamIds: [fx.team[abbrev].id], isCommissioner: false },
        { proposalId: p.id, teamId: fx.team[abbrev].id, choice: "yes" },
      );
    }

    const { proposal, tally } = await closeVoting(db, commish, p.id);
    expect(tally.yes).toBe(8);
    expect(proposal.status).toBe("passed");

    // A later tampering with the votes table cannot un-pass it.
    await db.delete(schema.votes).where(eq(schema.votes.proposalId, p.id));
    const after = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(after!.status).toBe("passed");
  });

  it("fails at 7 of 12", async () => {
    const p = await draft();
    await openVoting(db, commish, p.id, { closesAt: tomorrow() });

    const abbrevs = ["SACK", "BUES", "WFP", "NOVA", "DICK", "MAYE", "BYRN"] as const;
    for (const abbrev of abbrevs) {
      await castVote(
        db,
        { userId: fx.user.id, teamIds: [fx.team[abbrev].id], isCommissioner: false },
        { proposalId: p.id, teamId: fx.team[abbrev].id, choice: "yes" },
      );
    }

    const { proposal, tally } = await closeVoting(db, commish, p.id);
    expect(tally.yes).toBe(7);
    expect(proposal.status).toBe("failed");
  });

  it("refuses votes after the ballot is closed", async () => {
    const p = await draft();
    await openVoting(db, commish, p.id, { closesAt: tomorrow() });
    await closeVoting(db, commish, p.id);
    await expect(
      castVote(db, member, { proposalId: p.id, teamId: fx.team.WFP.id, choice: "yes" }),
    ).rejects.toThrow(/not open/i);
  });

  it("lets the author withdraw a draft, but not a stranger", async () => {
    const p = await draft();
    const stranger = { userId: 999, teamIds: [fx.team.DICK.id], isCommissioner: false };
    await expect(withdrawProposal(db, stranger, p.id)).rejects.toThrow(/author/i);
    await withdrawProposal(db, member, p.id);
    const after = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(after!.status).toBe("withdrawn");
  });
});
