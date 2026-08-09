import { SyncButton } from "@/components/sync-button";
import { Absent, Badge, Callout, Card, EmptyState } from "@/components/ui";
import { db } from "@/db";
import { latestSyncRun, seasonsForLeague, unlinkedSeats } from "@/db/queries";
import { getMembership } from "@/lib/auth/membership";
import { formatDate } from "@/lib/describe";
import { currentSeasonYear, getLeague } from "@/lib/league";

export default async function CommissionerPage() {
  const membership = await getMembership();
  if (!membership?.isCommissioner) {
    // Authorization in the page itself, not in a path matcher.
    return <Callout tone="danger">This page is for the league commissioner.</Callout>;
  }

  const league = await getLeague();
  const [seasons, seats, lastSync] = await Promise.all([
    seasonsForLeague(db, league.id),
    unlinkedSeats(db, league.id),
    latestSyncRun(db, league.id),
  ]);

  const thisYear = currentSeasonYear();
  const cookiesConfigured = Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Commissioner</h1>
        <p className="text-muted mt-1">League plumbing: ESPN sync and manager seats.</p>
      </div>

      <Card title="ESPN sync" subtitle="ESPN is a read-only mirror. It never touches the pick ledger.">
        <div className="p-5 space-y-4">
          {!cookiesConfigured ? (
            <Callout tone="warning" title="ESPN credentials not configured">
              NARC is a private league, so every ESPN request returns 401 without cookies. Set{" "}
              <code className="font-mono">ESPN_S2</code> and{" "}
              <code className="font-mono">ESPN_SWID</code> in your environment. Copy them from a
              logged-in browser: DevTools → Application → Cookies → espn.com. The SWID value
              includes its curly braces.
            </Callout>
          ) : (
            <SyncButton years={[thisYear]} />
          )}

          {lastSync && (
            <div className="text-sm text-muted">
              Last run: {formatDate(lastSync.startedAt)} ·{" "}
              <Badge
                tone={
                  lastSync.status === "success"
                    ? "accent"
                    : lastSync.status === "partial"
                      ? "warning"
                      : "danger"
                }
              >
                {lastSync.status}
              </Badge>
              {lastSync.error && <p className="mt-1 text-danger">{lastSync.error}</p>}
            </div>
          )}
        </div>
      </Card>

      <Card title="Seasons">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
                <th className="px-5 py-2 font-medium">Year</th>
                <th className="px-3 py-2 font-medium">Rounds</th>
                <th className="px-3 py-2 font-medium">Keepers</th>
                <th className="px-3 py-2 font-medium">ESPN</th>
                <th className="px-5 py-2 font-medium">Last synced</th>
              </tr>
            </thead>
            <tbody>
              {seasons.map((s) => (
                <tr key={s.id} className="border-b border-border/50 last:border-0">
                  <td className="px-5 py-2 tnum font-medium">{s.year}</td>
                  <td className="px-3 py-2 tnum">{s.draftRounds}</td>
                  <td className="px-3 py-2 tnum">{s.baseKeeperSlots}</td>
                  <td className="px-3 py-2">
                    {s.espnIsActive ? (
                      <Badge tone="accent">active</Badge>
                    ) : (
                      <Badge tone="warning">not reactivated</Badge>
                    )}
                  </td>
                  <td className="px-5 py-2 text-muted">
                    {s.lastSyncedAt ? formatDate(s.lastSyncedAt) : <Absent />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Manager seats awaiting sign-in"
        subtitle="A seat is claimed automatically when someone signs in with a matching invite email."
      >
        {seats.length === 0 ? (
          <EmptyState title="Every seat is claimed." />
        ) : (
          <ul className="divide-y divide-border">
            {seats.map((s) => (
              <li key={s.id} className="px-5 py-3 text-sm flex items-center gap-3 flex-wrap">
                <Badge>{s.team.abbrev}</Badge>
                <span>{s.displayNameOverride ?? "Unnamed manager"}</span>
                {s.leagueRole === "commissioner" && <Badge tone="info">Commish</Badge>}
                <span className="ml-auto text-muted">
                  {s.inviteEmail ?? <span className="text-warning">no invite email set</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
