/**
 * Seed the NARC league so the app is usable before ESPN cookies are wired up.
 *
 * Idempotent — safe to re-run. ESPN sync will later overwrite team names and
 * fill in the real ESPN member GUIDs; this exists so the trade ledger works on
 * day one, which matters because the 2026 season is still dormant on ESPN.
 */
import { and, eq, isNull } from "drizzle-orm";

import { ensureRollingWindow } from "./picks";
import * as schema from "./schema";
import type { DbOrTx } from "./types";

/**
 * Taken from the ESPN league page; `espnTeamId` is the "#" column.
 *
 * `commissioner` is who can void trades and open ballots in THIS app. Michael
 * Sacks is the ESPN League Manager; William Parker operates the app, so both
 * hold the role. Team BUES intentionally has two seats — ESPN lists both
 * "Rob Buesing" and "Robert Buesing".
 */
export const NARC_TEAMS = [
  { espnTeamId: 1, abbrev: "SACK", name: "Malik My Balls", managers: ["Michael Sacks"], commissioner: true },
  { espnTeamId: 2, abbrev: "BUES", name: "Warren Peace", managers: ["Rob Buesing", "Robert Buesing"] },
  { espnTeamId: 3, abbrev: "WFP", name: "Sloppy saquons at Zayffoni's", managers: ["William Parker"], commissioner: true, inviteEmail: "wparker@uchicago.edu" },
  { espnTeamId: 4, abbrev: "NOVA", name: "Triples Makes It Safe", managers: ["Zachary Brewer"] },
  { espnTeamId: 5, abbrev: "DICK", name: "Defense Is Crazy Kritical", managers: ["Will Eusden"] },
  { espnTeamId: 6, abbrev: "MAYE", name: "It's Gonna Be Maye", managers: ["cameron skinner"] },
  { espnTeamId: 7, abbrev: "BYRN", name: "Lions Eat Ass", managers: ["Benjamin Byrne"] },
  { espnTeamId: 8, abbrev: "HULL", name: "La La Lamb", managers: ["Tyler Hull"] },
  { espnTeamId: 9, abbrev: "cgm", name: "Everyone Has Jayds", managers: ["christopher murphy"] },
  { espnTeamId: 10, abbrev: "FLY", name: "The Bucky Stops Here", managers: ["Dan Costanza"] },
  { espnTeamId: 11, abbrev: "DPK", name: "Devonta's Peak", managers: ["PM Daniel"] },
  { espnTeamId: 12, abbrev: "WW", name: "Wan'Win", managers: ["Trevor Newman"] },
] satisfies Array<{
  espnTeamId: number;
  abbrev: string;
  name: string;
  managers: string[];
  commissioner?: boolean;
  inviteEmail?: string;
}>;

export async function seedLeague(
  db: DbOrTx,
  opts: { espnLeagueId: string; currentYear: number },
) {
  const { espnLeagueId, currentYear } = opts;

  await db
    .insert(schema.leagues)
    .values({ espnLeagueId, name: "NARC", teamCount: NARC_TEAMS.length })
    .onConflictDoNothing({ target: schema.leagues.espnLeagueId });

  const league = await db.query.leagues.findFirst({
    where: eq(schema.leagues.espnLeagueId, espnLeagueId),
  });
  if (!league) throw new Error("League missing immediately after upsert");

  for (const t of NARC_TEAMS) {
    await db
      .insert(schema.teams)
      .values({ leagueId: league.id, espnTeamId: t.espnTeamId, abbrev: t.abbrev, name: t.name })
      .onConflictDoUpdate({
        target: [schema.teams.leagueId, schema.teams.espnTeamId],
        set: { abbrev: t.abbrev, name: t.name },
      });

    const team = await db.query.teams.findFirst({
      where: and(eq(schema.teams.leagueId, league.id), eq(schema.teams.espnTeamId, t.espnTeamId)),
    });
    if (!team) throw new Error(`Team ${t.abbrev} missing after upsert`);

    // Seats are matched on display name because we have no ESPN member GUIDs
    // until the first sync links them.
    const existing = await db.query.teamManagers.findMany({
      where: eq(schema.teamManagers.teamId, team.id),
    });

    for (const [i, managerName] of t.managers.entries()) {
      if (existing.some((s) => s.displayNameOverride === managerName)) continue;
      await db.insert(schema.teamManagers).values({
        leagueId: league.id,
        teamId: team.id,
        displayNameOverride: managerName,
        role: i === 0 ? "primary" : "co",
        leagueRole: t.commissioner && i === 0 ? "commissioner" : "member",
        inviteEmail: i === 0 ? (t.inviteEmail ?? null) : null,
      });
    }
  }

  const seasons = await ensureRollingWindow(db, { leagueId: league.id, currentYear });

  const unlinked = await db.query.teamManagers.findMany({
    where: and(eq(schema.teamManagers.leagueId, league.id), isNull(schema.teamManagers.userId)),
  });

  return { league, seasons, unlinkedSeatCount: unlinked.length };
}
