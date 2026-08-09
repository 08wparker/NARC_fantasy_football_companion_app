import Link from "next/link";

import { TradeBuilder } from "@/components/trade-builder";
import { Callout, Card } from "@/components/ui";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { seasonsForLeague } from "@/db/queries";
import { getMembership } from "@/lib/auth/membership";
import { getLeague } from "@/lib/league";
import { eq } from "drizzle-orm";

export default async function NewTradePage() {
  const league = await getLeague();
  const membership = await getMembership();

  if (!membership) {
    return <Callout tone="info">Sign in to log a trade.</Callout>;
  }
  if (membership.isUnlinked) {
    return (
      <Callout tone="warning">
        Your account is not linked to a franchise yet, so you cannot log trades. Ask the
        commissioner to assign your seat.
      </Callout>
    );
  }

  const [teams, seasons, picks] = await Promise.all([
    db.query.teams.findMany({
      where: eq(schema.teams.leagueId, league.id),
      orderBy: (t, { asc }) => [asc(t.espnTeamId)],
    }),
    seasonsForLeague(db, league.id),
    db.query.draftPicks.findMany({
      with: { season: true, originalTeam: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/trades" className="text-sm text-muted hover:text-foreground">
          ← Trades
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-2">Log a trade</h1>
        <p className="text-muted mt-1">
          Record what was agreed. The other side confirms before anything moves.
        </p>
      </div>

      <Card>
        <div className="p-5">
          <TradeBuilder
            myTeamIds={membership.isCommissioner ? teams.map((t) => t.id) : membership.teamIds}
            teams={teams.map((t) => ({ id: t.id, abbrev: t.abbrev, name: t.name }))}
            seasons={seasons.map((s) => ({ id: s.id, year: s.year }))}
            picks={picks
              .filter((p) => !p.forfeited)
              .map((p) => ({
                id: p.id,
                round: p.round,
                seasonId: p.seasonId,
                year: p.season.year,
                ownerTeamId: p.currentOwnerTeamId,
                originalTeamAbbrev: p.originalTeam.abbrev,
              }))}
          />
        </div>
      </Card>
    </div>
  );
}
