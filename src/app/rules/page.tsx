import {
  CloseVotingButton,
  NewProposalForm,
  OpenVotingButton,
  VoteButtons,
  WithdrawButton,
} from "@/components/proposal-controls";
import { Badge, Callout, Card, EmptyState } from "@/components/ui";
import { db } from "@/db";
import { tallyVotes } from "@/db/proposal-service";
import { proposalsForLeague } from "@/db/queries";
import { getMembership } from "@/lib/auth/membership";
import { formatDate } from "@/lib/describe";
import { getLeague } from "@/lib/league";

const STATUS_TONE = {
  draft: "neutral",
  open: "info",
  passed: "accent",
  failed: "danger",
  withdrawn: "neutral",
} as const;

export default async function RulesPage() {
  const league = await getLeague();
  const membership = await getMembership();
  const canAct = membership && !membership.isUnlinked;

  const proposals = await proposalsForLeague(db, league.id);
  const teamCount = league.teamCount;

  const order = { open: 0, draft: 1, passed: 2, failed: 3, withdrawn: 4 } as const;
  const sorted = [...proposals].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rule changes</h1>
          <p className="text-muted mt-1">
            Anyone can propose. The commissioner opens the ballot.
          </p>
        </div>
        {canAct && (
          <div className="ml-auto">
            <NewProposalForm />
          </div>
        )}
      </div>

      <Callout tone="neutral">
        A proposal needs a supermajority of <strong>all {teamCount} franchises</strong>, not just
        those who vote. Abstaining and not voting have the same effect as a no.
      </Callout>

      {sorted.length === 0 ? (
        <Card>
          <EmptyState title="No rule changes proposed yet." />
        </Card>
      ) : (
        <div className="space-y-4">
          {sorted.map((p) => {
            const tally = tallyVotes(p.votes, {
              eligible: p.eligibleVoterCount ?? teamCount,
              numerator: p.thresholdNumerator,
              denominator: p.thresholdDenominator,
            });

            const myVote = canAct
              ? p.votes.find((v) => membership.teamIds.includes(v.teamId))
              : undefined;
            const myTeamId = membership?.teamIds[0];

            const pct = Math.min(100, Math.round((tally.yes / Math.max(1, tally.requiredYes)) * 100));

            return (
              <Card key={p.id}>
                <div className="p-5 space-y-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="font-semibold">{p.title}</h2>
                        <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                        <span className="text-xs text-muted">
                          {p.thresholdNumerator}/{p.thresholdDenominator} required
                        </span>
                      </div>
                      <p className="text-sm text-muted mt-1">
                        Proposed by {p.proposedByUser.displayName ?? "a manager"} ·{" "}
                        {formatDate(p.createdAt)}
                        {p.closesAt && p.status === "open" && (
                          <> · closes {formatDate(p.closesAt)}</>
                        )}
                      </p>
                    </div>

                    <div className="ml-auto flex flex-wrap gap-2">
                      {membership?.isCommissioner && p.status === "draft" && (
                        <OpenVotingButton proposalId={p.id} />
                      )}
                      {membership?.isCommissioner && p.status === "open" && (
                        <CloseVotingButton proposalId={p.id} />
                      )}
                      {canAct &&
                        (p.status === "draft" || p.status === "open") &&
                        (p.proposedByUserId === membership.userId ||
                          membership.isCommissioner) && <WithdrawButton proposalId={p.id} />}
                    </div>
                  </div>

                  <p className="text-sm whitespace-pre-wrap">{p.body}</p>

                  {p.status !== "draft" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline gap-3 text-sm">
                        <span className="tnum font-medium">
                          {tally.yes} yes · {tally.no} no
                          {tally.abstain > 0 && ` · ${tally.abstain} abstain`}
                        </span>
                        <span className="text-muted tnum">
                          needs {tally.requiredYes} of {tally.eligible}
                        </span>
                        {tally.notVoted > 0 && p.status === "open" && (
                          <span className="text-muted tnum">
                            {tally.notVoted} have not voted
                          </span>
                        )}
                      </div>

                      <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            tally.passed ? "bg-accent" : "bg-info"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>

                      {p.status === "open" && tally.mathematicallyFailed && (
                        <p className="text-xs text-danger">
                          Cannot reach {tally.requiredYes} yes even if everyone remaining votes for
                          it.
                        </p>
                      )}

                      {p.votes.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {p.votes.map((v) => (
                            <span
                              key={v.id}
                              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                                v.choice === "yes"
                                  ? "border-accent/30 bg-accent/10 text-accent"
                                  : v.choice === "no"
                                    ? "border-danger/30 bg-danger/10 text-danger"
                                    : "border-border bg-surface-2 text-muted"
                              }`}
                              title={`${v.team.abbrev} voted ${v.choice}`}
                            >
                              {v.team.abbrev}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {p.status === "open" && canAct && myTeamId !== undefined && (
                    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                      <span className="text-sm text-muted">Your franchise&apos;s ballot</span>
                      <VoteButtons
                        proposalId={p.id}
                        teamId={myTeamId}
                        current={myVote?.choice}
                      />
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
