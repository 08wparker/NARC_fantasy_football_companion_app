import { Badge, Callout, Card, EmptyState, StatTile, TeamChip, pickLabel } from "@/components/ui";
import { RosterRefreshButton } from "@/components/roster-refresh-button";
import { db } from "@/db";
import { latestSeasonWithRosters, rostersForSeason } from "@/db/queries";
import { getMembership } from "@/lib/auth/membership";
import { type AdpBoard, type AdpSource } from "@/lib/adp";
import { getAdpBoard } from "@/lib/espn/adp";
import { formatDate, ordinal } from "@/lib/describe";
import { EspnAuthError, EspnError, credentialsFromEnv } from "@/lib/espn/client";
import { getLatestDraftRecap, type DraftRecap } from "@/lib/espn/draft";
import { UNDRAFTED_KEEPER_ROUND } from "@/lib/keepers";
import { ESPN_LEAGUE_ID, currentSeasonYear, getLeague } from "@/lib/league";
import { buildKeeperRosters, type KeeperCost, type KeeperRosterPlayer } from "@/lib/rosters";

/**
 * Every team's roster with what each player costs to keep.
 *
 * The two halves come from different places on purpose. Rosters are read from
 * the ESPN *mirror*, so the page renders instantly and still works when ESPN is
 * down; the "Refresh from ESPN" button is what re-pulls them. Prices are
 * derived from the last draft recap, which is fetched live and cached — a
 * completed draft is immutable, so there is nothing to mirror.
 *
 * A recap that fails to load degrades to "no price", never to "cannot be
 * kept": the league would read a blank column as a ruling.
 */
export default async function CurrentRostersPage() {
  const league = await getLeague();
  const [membership, season] = await Promise.all([
    getMembership(),
    latestSeasonWithRosters(db, league.id),
  ]);

  // The action behind the button requires a claimed seat, so only offer it to
  // someone who holds one — the same check the action itself re-runs.
  const canRefresh = Boolean(membership && !membership.isUnlinked);
  const refresh = canRefresh ? <RosterRefreshButton /> : null;

  // Missing cookies are handled as "no prices", not as a dead page: rosters
  // already in the mirror are still worth showing, and asking ESPN without them
  // would just 401 and report the cookies as *expired*, which is a different
  // problem with a different fix.
  const hasCredentials = Boolean(credentialsFromEnv());

  if (!season) {
    return (
      <Shell action={refresh}>
        {!hasCredentials && <MissingCredentials />}
        <EmptyState
          title="No rosters have been pulled from ESPN yet."
          hint={
            canRefresh
              ? "Hit “Refresh from ESPN” to mirror them."
              : "A manager can pull them in with the refresh button."
          }
        />
      </Shell>
    );
  }

  const rosters = await rostersForSeason(db, season.id);
  const rosteredEspnIds = rosters.flatMap((r) =>
    r.players.map((p) => p.espnPlayerId).filter((id): id is number => id !== null),
  );

  let recap: DraftRecap | null = null;
  let recapError: unknown = null;
  let adp: AdpBoard | null = null;
  if (hasCredentials) {
    // Independent reads, and the market is the optional half: a failed ADP
    // lookup must not cost the page its keeper prices, so they settle apart.
    const [recapResult, adpResult] = await Promise.allSettled([
      getLatestDraftRecap(ESPN_LEAGUE_ID, currentSeasonYear()),
      getAdpBoard(ESPN_LEAGUE_ID, currentSeasonYear(), rosteredEspnIds),
    ]);
    if (recapResult.status === "fulfilled") recap = recapResult.value;
    else recapError = recapResult.reason;
    if (adpResult.status === "fulfilled" && adpResult.value.entries.length > 0) {
      adp = adpResult.value;
    }
  }
  // A season ESPN has not drafted yet prices nothing, same as an unreachable one.
  const priced = recap?.drafted ? recap : null;

  const teams = buildKeeperRosters(rosters, priced, adp, league.teamCount);
  const abbrevByEspnTeamId = new Map(teams.map((t) => [t.espnTeamId, t.abbrev]));
  const playerCount = teams.reduce((n, t) => n + t.players.length, 0);
  const keepableCount = teams.reduce((n, t) => n + t.keepableCount, 0);
  const ineligibleCount = teams.reduce(
    (n, t) => n + t.players.filter((p) => p.cost.kind === "ineligible").length,
    0,
  );
  const keeperYear = priced ? priced.year + 1 : null;

  return (
    <Shell
      action={refresh}
      subtitle={
        `${season.year} rosters` +
        (priced ? ` · keeper prices for ${keeperYear}, off the ${priced.year} draft` : "") +
        (season.lastSyncedAt ? ` · synced ${formatDate(season.lastSyncedAt)}` : "")
      }
    >
      {!hasCredentials && <MissingCredentials />}
      {hasCredentials && recapError ? renderRecapFailure(recapError) : null}
      {hasCredentials && !recapError && !priced && (
        <Callout tone="info" title="No completed draft to price against">
          ESPN has no finished draft yet, so there is no round to charge from. Prices appear the
          day the draft completes.
        </Callout>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Players rostered" value={playerCount} />
        <StatTile
          label="Keepable"
          value={priced ? keepableCount : "—"}
          hint={priced ? `eligible to keep in ${keeperYear}` : "needs a completed draft"}
        />
        <StatTile
          label="Cannot be kept"
          value={priced ? ineligibleCount : "—"}
          hint="went in rounds 1–3"
        />
      </div>

      {playerCount === 0 ? (
        <EmptyState
          title={`ESPN reports no rostered players for ${season.year}.`}
          hint="A season ESPN has not reactivated comes back empty, not as an error."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <Card
              key={team.teamId}
              title={team.name}
              subtitle={
                <span className="flex items-center gap-2">
                  <TeamChip abbrev={team.abbrev} />
                  <span>
                    {team.players.length} rostered
                    {priced && ` · ${team.keepableCount} keepable`}
                    {priced && adp && ` · ${team.bargainCount} under ADP`}
                  </span>
                </span>
              }
            >
              {team.players.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted">Nobody rostered.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {team.players.map((player) => (
                    <li key={player.playerId} className="flex items-baseline gap-3 px-5 py-3">
                      <DraftOrigin
                        player={player}
                        team={team.espnTeamId}
                        abbrevs={abbrevByEspnTeamId}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{player.fullName}</span>
                        {player.position && (
                          <span className="ml-2 text-xs text-muted">{player.position}</span>
                        )}
                        {player.wasKept && (
                          <span className="ml-2 align-middle">
                            <Badge tone="accent">kept</Badge>
                          </span>
                        )}
                      </span>
                      {adp && <AdpCell player={player} source={adp.source} />}
                      <KeeperPrice cost={player.cost} year={keeperYear} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted">
        The right-hand column is what each player costs to keep
        {keeperYear ? ` in ${keeperYear}` : ""}: three rounds better than where he went, so a{" "}
        {ordinal(7)} becomes a {ordinal(4)}, compounding every year he is kept. Rounds 1–3 have no
        cheaper round to charge, so those players cannot be kept; anyone undrafted costs a{" "}
        {ordinal(UNDRAFTED_KEEPER_ROUND)}. Keeper rights travel with the player, so a player
        acquired by trade carries the price his drafting team set. Rosters come from the last ESPN
        sync — refresh to re-pull them.
      </p>

      {adp && (
        <p className="text-xs text-muted">
          The middle column is where the {adp.year} market has each player going, converted to a
          round for a {league.teamCount}-team draft, with the rounds of profit underneath: green{" "}
          <span className="text-accent/80">+3</span> means keeping him costs three rounds later
          than his draft slot, amber means the draft is the cheaper way to get him.{" "}
          {adp.source === "average-draft-position" ? (
            <>Read from ESPN&rsquo;s average draft position.</>
          ) : (
            <>
              Read from ESPN&rsquo;s PPR draft ranking — a ranking, not a measured ADP, which is
              what ESPN publishes when it has no draft data to average.
            </>
          )}
        </p>
      )}
    </Shell>
  );
}

/** Where the player went in the last draft, in the "3.04" form drafters say. */
function DraftOrigin({
  player,
  team,
  abbrevs,
}: {
  player: KeeperRosterPlayer;
  team: number;
  abbrevs: Map<number, string>;
}) {
  if (player.draftedRound === null) {
    return (
      <span className="w-9 shrink-0 font-mono tnum text-xs text-muted/50">
        {player.cost.kind === "unknown" ? "?" : "UDFA"}
      </span>
    );
  }

  // Acquired by trade or waiver: whose pick actually paid for him.
  const from =
    player.draftedByEspnTeamId !== null && player.draftedByEspnTeamId !== team
      ? abbrevs.get(player.draftedByEspnTeamId)
      : null;

  return (
    <span
      className="w-9 shrink-0 font-mono tnum text-xs text-muted"
      title={from ? `Drafted by ${from}` : undefined}
    >
      {pickLabel(player.draftedRound, player.draftedPickInRound ?? 0)}
      {from && <span className="block text-[10px] text-muted/60">{from}</span>}
    </span>
  );
}

/**
 * Where the market has the player going, as a round, plus what keeping him
 * saves against that.
 *
 * The surplus is the number the decision actually turns on — a 5th-round
 * keeper who goes in the 2nd is three rounds of profit — so it is rendered
 * next to the round rather than left for the reader to subtract. It only
 * appears on a real price: "cannot be kept" has no round to compare, and a
 * negative surplus (the draft is the cheaper way to get him) is shown plainly
 * rather than hidden, since that is a keep worth reconsidering.
 */
function AdpCell({ player, source }: { player: KeeperRosterPlayer; source: AdpSource }) {
  const label =
    source === "average-draft-position"
      ? `Average draft position ${player.adpPick?.toFixed(1)}`
      : `ESPN PPR draft rank ${player.adpPick}`;

  if (player.adpRound === null) {
    return (
      <span
        className="w-14 shrink-0 text-right text-xs text-muted/40"
        title="ESPN ranks this player in no draft format"
      >
        —
      </span>
    );
  }

  const surplus = player.surplus;
  return (
    <span className="w-14 shrink-0 text-right text-xs tnum" title={label}>
      <span className="text-muted">{ordinal(player.adpRound)}</span>
      {surplus !== null && surplus !== 0 && (
        <span
          className={`block text-[10px] ${surplus > 0 ? "text-accent/80" : "text-warning/80"}`}
          title={
            surplus > 0
              ? `Keeping him costs ${surplus} round${surplus === 1 ? "" : "s"} later than the market`
              : `The market has him ${-surplus} round${surplus === -1 ? "" : "s"} later than his keeper price`
          }
        >
          {surplus > 0 ? `+${surplus}` : surplus}
        </span>
      )}
    </span>
  );
}

/**
 * The price, in three states that must stay visually distinct: a round, a
 * player nobody may keep, and one we could not price at all.
 */
function KeeperPrice({ cost, year }: { cost: KeeperCost; year: number | null }) {
  const forYear = year ? ` in ${year}` : "";

  switch (cost.kind) {
    case "round":
      return (
        <span
          className="shrink-0 text-xs tnum text-accent/90"
          title={`Keeper round${forYear}${cost.undrafted ? " — went undrafted" : ""}`}
        >
          {ordinal(cost.round)}
        </span>
      );
    case "ineligible":
      return (
        <span
          className="shrink-0 text-xs text-muted/50"
          title={`A ${ordinal(cost.previousRound)}-round pick has no cheaper round to charge, so he cannot be kept${forYear}`}
        >
          no keep
        </span>
      );
    case "unknown":
      return (
        <span className="shrink-0 text-xs text-muted/50" title="No draft data for this player">
          —
        </span>
      );
  }
}

function MissingCredentials() {
  return (
    <Callout tone="warning" title="ESPN credentials are not configured">
      NARC is private, so nothing can be pulled without the <code>espn_s2</code> and{" "}
      <code>SWID</code> cookies — including the draft the keeper prices are read off. Set them in{" "}
      <code>.env.local</code>, then run <code>npm run espn:check</code>.
    </Callout>
  );
}

function Shell({
  children,
  subtitle,
  action,
}: {
  children: React.ReactNode;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Current rosters</h1>
          <p className="text-muted mt-1">{subtitle ?? "Who is on each team, and what they cost to keep."}</p>
        </div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  );
}

function renderRecapFailure(error: unknown) {
  if (error instanceof EspnAuthError) {
    return (
      <Callout tone="warning" title="ESPN rejected the saved cookies, so keeper prices are missing">
        Rosters below are from the last successful sync. Re-copy <code>espn_s2</code> and{" "}
        <code>SWID</code>, then run <code>npm run espn:check</code>.
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="Keeper prices could not be loaded">
      The last draft is read live from ESPN and it did not answer
      {error instanceof EspnError ? ` — ${error.message}` : ""}. Rosters below are still the ones
      from the last sync.
    </Callout>
  );
}
