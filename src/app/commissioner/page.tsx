import { SeatControls } from "@/components/seat-controls";
import { SyncButton } from "@/components/sync-button";
import { Absent, Badge, Callout, Card, EmptyState } from "@/components/ui";
import { db } from "@/db";
import { allSeats, allUsers, latestSyncRun, seasonsForLeague } from "@/db/queries";
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
  const [seasons, seats, users, lastSync] = await Promise.all([
    seasonsForLeague(db, league.id),
    allSeats(db, league.id),
    allUsers(db),
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
        title="Manager seats"
        subtitle="Set an invite email and a manager claims their seat automatically on first sign-in. Everyone needs one."
      >
        {seats.length === 0 ? (
          <EmptyState title="No manager seats. Run the seed script." />
        ) : (
          <ul className="divide-y divide-border">
            {seats.map((s) => (
              <li key={s.id} className="px-5 py-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <Badge>{s.team.abbrev}</Badge>
                  <span className="font-medium">
                    {s.displayNameOverride ?? s.user?.displayName ?? "Unnamed manager"}
                  </span>
                  {s.role === "co" && <span className="text-xs text-muted">co-manager</span>}
                  {s.leagueRole === "commissioner" && <Badge tone="info">Commish</Badge>}
                  {!s.isActive && <Badge tone="warning">inactive</Badge>}
                  {s.user ? (
                    <Badge tone="accent">signed in</Badge>
                  ) : (
                    <Badge tone="warning">not claimed</Badge>
                  )}
                  {s.user?.email && (
                    <span className="text-xs text-muted">{s.user.email}</span>
                  )}
                </div>

                <SeatControls
                  seat={{
                    id: s.id,
                    teamAbbrev: s.team.abbrev,
                    teamName: s.team.name,
                    displayName: s.displayNameOverride,
                    inviteEmail: s.inviteEmail,
                    isCommissioner: s.leagueRole === "commissioner",
                    isActive: s.isActive,
                    role: s.role,
                    user: s.user
                      ? { id: s.user.id, displayName: s.user.displayName, email: s.user.email }
                      : null,
                  }}
                  users={users.map((u) => ({
                    id: u.id,
                    displayName: u.displayName,
                    email: u.email,
                  }))}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
