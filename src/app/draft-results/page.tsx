import Link from "next/link";

import { Absent, Badge, Callout, Card, EmptyState, StatTile, TeamChip, pickLabel } from "@/components/ui";
import { EspnAuthError, EspnError, credentialsFromEnv } from "@/lib/espn/client";
import { getDraftRecap, type DraftRecap } from "@/lib/espn/draft";
import { ESPN_LEAGUE_ID, currentSeasonYear } from "@/lib/league";

/**
 * What the league actually drafted, read live from ESPN.
 *
 * This is the app's first page that renders someone else's outage, so every
 * failure mode below degrades to a Callout. A dead ESPN must not 500 a page
 * anyone can load.
 */
export default async function DraftResultsPage(props: PageProps<"/draft-results">) {
  // Next 16: searchParams is a Promise.
  const searchParams = await props.searchParams;

  if (!credentialsFromEnv()) {
    return (
      <Shell>
        <Callout tone="warning" title="ESPN credentials are not configured">
          This league is private, so draft history cannot be read without the{" "}
          <code>espn_s2</code> and <code>SWID</code> cookies. Set them in <code>.env.local</code>,
          then run <code>npm run espn:check</code>.
        </Callout>
      </Shell>
    );
  }

  const requested = Number(searchParams.year);
  const explicitYear = Number.isInteger(requested) && requested > 1990;

  let recap: DraftRecap;
  try {
    recap = await getDraftRecap(ESPN_LEAGUE_ID, explicitYear ? requested : currentSeasonYear());

    // Nobody wants to land on an empty page in the offseason. If this season's
    // draft has not happened yet, fall back to the most recent one that did.
    if (!explicitYear && !recap.drafted) {
      const previous = await getDraftRecap(ESPN_LEAGUE_ID, recap.year - 1);
      if (previous.drafted) recap = previous;
    }
  } catch (error) {
    return <Shell>{renderFailure(error)}</Shell>;
  }

  const years = recap.availableYears;

  return (
    <Shell
      subtitle={
        recap.drafted
          ? `${recap.pickCount} picks over ${recap.roundCount} rounds · ${recap.keeperCount} kept`
          : "The board as ESPN has it"
      }
      switcher={
        years.length > 1 && (
          <nav className="ml-auto flex flex-wrap gap-1">
            {years.map((y) => (
              <Link
                key={y}
                href={`/draft-results?year=${y}`}
                className={`rounded-md px-3 py-1.5 text-sm tnum transition-colors ${
                  y === recap.year
                    ? "bg-accent text-background font-medium"
                    : "text-muted hover:text-foreground hover:bg-surface-2"
                }`}
              >
                {y}
              </Link>
            ))}
          </nav>
        )
      }
    >
      {!recap.drafted ? (
        <EmptyState
          title={`ESPN has no completed draft for ${recap.year}.`}
          hint="It will appear here once the draft runs."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="Rounds" value={recap.roundCount} />
            <StatTile label="Picks" value={recap.pickCount} />
            <StatTile
              label="Keepers"
              value={recap.keeperCount}
              hint="picks consumed by a kept player"
            />
          </div>

          {/* Three columns, not four: a fourth squeezes the keeper badge into the
              player name and wraps it onto two lines. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recap.teams.map((team) => (
              <Card key={team.espnTeamId} title={team.name} subtitle={<TeamChip abbrev={team.abbrev} />}>
                <ul className="divide-y divide-border">
                  {team.picks.map((pick) => (
                    <li key={pick.overall} className="flex items-baseline gap-3 px-5 py-3">
                      <span className="w-9 shrink-0 font-mono tnum text-xs text-muted">
                        {pickLabel(pick.round, pick.roundPick)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{pick.playerName ?? <Absent />}</span>
                        {pick.position && (
                          <span className="ml-2 text-xs text-muted">{pick.position}</span>
                        )}
                      </span>
                      {pick.keeper && <Badge tone="accent">kept</Badge>}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </>
      )}

      <p className="text-xs text-muted">
        Read live from ESPN and cached for an hour. This is the draft as it happened — for who owns
        which <em>future</em> pick, see the draft board.
      </p>
    </Shell>
  );
}

function Shell({
  children,
  subtitle,
  switcher,
}: {
  children: React.ReactNode;
  subtitle?: string;
  switcher?: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Draft results</h1>
          <p className="text-muted mt-1">{subtitle ?? "Past drafts, straight from ESPN."}</p>
        </div>
        {switcher}
      </div>
      {children}
    </div>
  );
}

function renderFailure(error: unknown) {
  if (error instanceof EspnAuthError) {
    return (
      <Callout tone="warning" title="ESPN rejected the saved cookies">
        They expire on any ESPN logout or password change. Re-copy <code>espn_s2</code> and{" "}
        <code>SWID</code>, then run <code>npm run espn:check</code> to confirm.
      </Callout>
    );
  }
  if (error instanceof EspnError) {
    // A 404 is the ordinary "you typed a year the league did not exist in"
    // case, not an outage, so it should not read like one.
    if (error.status === 404) {
      return (
        <Callout tone="warning" title="No such season">
          ESPN has no record of this league in that year.{" "}
          <Link href="/draft-results" className="underline">
            Back to the latest draft
          </Link>
          .
        </Callout>
      );
    }
    return (
      <Callout tone="danger" title="ESPN could not be reached">
        {error.message}
      </Callout>
    );
  }
  return (
    <Callout tone="danger" title="Could not load the draft">
      {error instanceof Error ? error.message : String(error)}
    </Callout>
  );
}
