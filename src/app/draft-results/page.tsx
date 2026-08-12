import { Absent, Badge, Callout, Card, EmptyState, StatTile, TeamChip, pickLabel } from "@/components/ui";
import { EspnAuthError, EspnError, credentialsFromEnv } from "@/lib/espn/client";
import { getLatestDraftRecap, type DraftRecap } from "@/lib/espn/draft";
import { UNDRAFTED_KEEPER_ROUND } from "@/lib/keepers";
import { ESPN_LEAGUE_ID, currentSeasonYear } from "@/lib/league";
import { ordinal } from "@/lib/describe";

/**
 * The last draft that happened, and what each pick costs to keep next year.
 *
 * Deliberately shows one season and offers no year picker: the league's keeper
 * math only ever looks back exactly one draft, so older years are trivia. (The
 * picker that used to be here was also wrong — it was built from ESPN's
 * `previousSeasons`, which lists only years *before* the one loaded, so
 * selecting a year made every later year vanish from the list.)
 *
 * This is the app's only render-time ESPN consumer, so every failure below
 * degrades to a Callout. A dead ESPN must not 500 a page anyone can load.
 */
export default async function DraftResultsPage() {
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

  let recap: DraftRecap;
  try {
    recap = await getLatestDraftRecap(ESPN_LEAGUE_ID, currentSeasonYear());
  } catch (error) {
    return <Shell>{renderFailure(error)}</Shell>;
  }

  if (!recap.drafted) {
    return (
      <Shell subtitle={`${recap.year} season`}>
        <EmptyState
          title={`ESPN has no completed draft for ${recap.year}.`}
          hint="It will appear here once the draft runs."
        />
      </Shell>
    );
  }

  return (
    <Shell
      subtitle={`${recap.year} draft · ${recap.pickCount} picks over ${recap.roundCount} rounds · ${recap.keeperCount} kept`}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Rounds" value={recap.roundCount} />
        <StatTile label="Picks" value={recap.pickCount} />
        <StatTile label="Keepers" value={recap.keeperCount} hint="picks consumed by a kept player" />
      </div>

      {/* Three columns, not four: a fourth squeezes the keeper column into the
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
                    {pick.position && <span className="ml-2 text-xs text-muted">{pick.position}</span>}
                    {pick.keeper && (
                      <span className="ml-2 align-middle">
                        <Badge tone="accent">kept</Badge>
                      </span>
                    )}
                  </span>
                  <KeeperCost round={pick.keeperRound} year={recap.year + 1} />
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted">
        The right-hand column is what each player costs to keep in {recap.year + 1}: three rounds
        better than where he went, so a {ordinal(7)} becomes a {ordinal(4)}. It compounds every
        year he is kept. Rounds 1–3 have no cheaper round to charge, so those players cannot be
        kept. Anyone undrafted in {recap.year} costs a {ordinal(UNDRAFTED_KEEPER_ROUND)}. Read live
        from ESPN and cached for an hour — for who owns which <em>future</em> pick, see the draft
        board.
      </p>
    </Shell>
  );
}

/** Right-aligned keeper price. Ineligible is shown, not omitted — a blank cell
 *  reads as missing data rather than "you cannot keep this player". */
function KeeperCost({ round, year }: { round: number | null; year: number }) {
  if (round === null) {
    return (
      <span className="shrink-0 text-xs text-muted/50" title={`Cannot be kept in ${year}`}>
        no keep
      </span>
    );
  }
  return (
    <span className="shrink-0 text-xs tnum text-accent/90" title={`Keeper round in ${year}`}>
      {ordinal(round)}
    </span>
  );
}

function Shell({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Draft results</h1>
        <p className="text-muted mt-1">{subtitle ?? "The last draft, straight from ESPN."}</p>
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
