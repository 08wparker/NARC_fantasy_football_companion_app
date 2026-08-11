import Link from "next/link";

import { Badge, Callout, Card, EmptyState, StatTile, TeamChip } from "@/components/ui";
import { db } from "@/db";
import { picksOwnedByTeam, proposalsForLeague, seasonsForLeague } from "@/db/queries";
import { pendingForActor } from "@/db/trade-service";
import { getMembership } from "@/lib/auth/membership";
import { currentSeasonYear, getLeague } from "@/lib/league";

export default async function HomePage() {
  let league;
  try {
    league = await getLeague();
  } catch {
    return (
      <Callout tone="warning" title="Database not seeded yet">
        Run <code className="font-mono">npm run db:migrate</code> then{" "}
        <code className="font-mono">npm run db:seed</code> to create the league and its 12
        franchises.
      </Callout>
    );
  }

  const membership = await getMembership();
  const [seasons, proposals] = await Promise.all([
    seasonsForLeague(db, league.id),
    proposalsForLeague(db, league.id),
  ]);

  const thisYear = currentSeasonYear();
  const currentSeason = seasons.find((s) => s.year === thisYear);
  const openProposals = proposals.filter((p) => p.status === "open");

  const pending = membership && !membership.isUnlinked
    ? await pendingForActor(db, league.id, membership)
    : [];

  const myPicks =
    membership && membership.teamIds.length > 0
      ? await picksOwnedByTeam(db, membership.teamIds[0])
      : [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {league.name} <span className="text-muted font-normal">· North Adams Rowing Club</span>
        </h1>
        <p className="text-muted mt-1">
          The record of everything ESPN forgets: traded picks, slot swaps, keeper rights.
        </p>
      </div>

      {!membership && (
        <Callout tone="info" title="Sign in to log trades and vote">
          Anyone in the league can browse the draft board and trade history. Signing in is what
          lets you log a trade and cast your franchise&apos;s ballot.
        </Callout>
      )}

      {membership?.isUnlinked && (
        <Callout tone="warning" title="You are not linked to a franchise yet">
          Ask the commissioner to assign your account to a team. Until then you can look, but not
          log trades or vote.
        </Callout>
      )}

      {currentSeason && !currentSeason.espnIsActive && (
        <Callout tone="warning" title={`ESPN has not reactivated the ${thisYear} season`}>
          Records and rosters are unavailable until the League Manager reactivates the league.
          The pick ledger below does not depend on ESPN and is accurate now.
        </Callout>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Awaiting you"
          value={pending.length}
          hint={pending.length === 1 ? "trade to confirm" : "trades to confirm"}
        />
        <StatTile
          label="Open votes"
          value={openProposals.length}
          hint={openProposals.length === 1 ? "rule proposal" : "rule proposals"}
        />
        <StatTile
          label="Seasons tracked"
          value={seasons.length}
          hint={seasons.length > 0 ? `${seasons[0].year}–${seasons[seasons.length - 1].year}` : ""}
        />
      </div>

      {pending.length > 0 && (
        <Card
          title="Trades waiting on you"
          subtitle="A trade only moves picks once the other side confirms it."
          action={
            <Link href="/trades" className="text-sm text-accent hover:underline">
              Review →
            </Link>
          }
        >
          <ul className="divide-y divide-border">
            {pending.map((t) => (
              <li key={t.id} className="px-5 py-3 text-sm flex items-center gap-3">
                <Badge tone="warning">Pending</Badge>
                <span className="text-muted">
                  {t.assets.length} asset{t.assets.length === 1 ? "" : "s"}
                </span>
                <Link href="/trades" className="ml-auto text-accent hover:underline">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {membership && !membership.isUnlinked && (
        <Card title="Your future picks" subtitle="Including everything you have acquired by trade.">
          {myPicks.length === 0 ? (
            <EmptyState title="No picks on the books yet." />
          ) : (
            <ul className="divide-y divide-border">
              {myPicks.map((group) => (
                <li key={group.year} className="px-5 py-3">
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="font-medium tnum">{group.year}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {group.picks.map((p) => (
                        <span
                          key={p.id}
                          className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-0.5 text-xs"
                          title={
                            p.originalTeamId === p.currentOwnerTeamId
                              ? "Your own pick"
                              : `Acquired from ${p.originalTeam.abbrev}`
                          }
                        >
                          <span className="tnum">R{p.round}</span>
                          {p.originalTeamId !== p.currentOwnerTeamId && (
                            <>
                              <span className="text-muted">via</span>
                              <TeamChip abbrev={p.originalTeam.abbrev} />
                            </>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {openProposals.length > 0 && (
        <Card
          title="Open rule votes"
          action={
            <Link href="/rules" className="text-sm text-accent hover:underline">
              Vote →
            </Link>
          }
        >
          <ul className="divide-y divide-border">
            {openProposals.map((p) => (
              <li key={p.id} className="px-5 py-3 text-sm">
                <span className="font-medium">{p.title}</span>
                <span className="text-muted ml-2">
                  {p.votes.length} of {p.eligibleVoterCount ?? 12} voted
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
