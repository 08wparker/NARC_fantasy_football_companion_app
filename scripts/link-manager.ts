/**
 * Escape hatch for manager seats — works with no session and no commissioner.
 *
 * The app's seat UI requires you to already BE a commissioner, which is circular
 * if nobody has claimed a commissioner seat yet, or if the claim-by-email path
 * misfires. This is the way back in without hand-writing SQL.
 *
 *   npm run db:link -- --list
 *   npm run db:link -- --email wparker@uchicago.edu --team WFP --commissioner
 *   npm run db:link -- --email tyler@example.com --team HULL
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import * as schema from "@/db/schema";

const ESPN_LEAGUE_ID = process.env.ESPN_LEAGUE_ID ?? "718396";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const league = await db.query.leagues.findFirst({
    where: eq(schema.leagues.espnLeagueId, ESPN_LEAGUE_ID),
  });
  if (!league) throw new Error(`League ${ESPN_LEAGUE_ID} not found. Run \`npm run db:seed\`.`);

  const seats = await db.query.teamManagers.findMany({
    where: eq(schema.teamManagers.leagueId, league.id),
    with: { team: true, user: true },
  });
  seats.sort((a, b) => a.team.espnTeamId - b.team.espnTeamId || a.id - b.id);

  if (has("list") || (!arg("email") && !arg("team"))) {
    console.log(`\n${league.name} — manager seats\n`);
    console.log(
      ["TEAM".padEnd(6), "MANAGER".padEnd(20), "INVITE EMAIL".padEnd(30), "CLAIMED BY"].join(""),
    );
    for (const s of seats) {
      const flags = [
        s.leagueRole === "commissioner" ? "commish" : null,
        s.role === "co" ? "co" : null,
        !s.isActive ? "inactive" : null,
      ]
        .filter(Boolean)
        .join(",");
      console.log(
        [
          s.team.abbrev.padEnd(6),
          (s.displayNameOverride ?? "—").slice(0, 19).padEnd(20),
          (s.inviteEmail ?? "—").slice(0, 29).padEnd(30),
          s.user ? (s.user.email ?? s.user.displayName ?? `#${s.user.id}`) : "—",
          flags ? `  [${flags}]` : "",
        ].join(""),
      );
    }

    const live = seats.filter(
      (s) => s.leagueRole === "commissioner" && s.isActive && s.userId !== null,
    );
    console.log(
      `\n${live.length} commissioner seat(s) actually held.` +
        (live.length === 0
          ? " Nobody can administer the league — set one with --commissioner."
          : ""),
    );
    console.log(
      "\nUsage: npm run db:link -- --email <addr> --team <ABBREV> [--commissioner]\n",
    );
    return;
  }

  const email = arg("email")?.trim().toLowerCase();
  const teamAbbrev = arg("team")?.trim();
  if (!email || !teamAbbrev) {
    throw new Error("Both --email and --team are required. Use --list to see seats.");
  }

  const seat = seats.find((s) => s.team.abbrev.toLowerCase() === teamAbbrev.toLowerCase());
  if (!seat) {
    throw new Error(
      `No team "${teamAbbrev}". Available: ${[...new Set(seats.map((s) => s.team.abbrev))].join(", ")}`,
    );
  }

  await db
    .update(schema.teamManagers)
    .set({
      inviteEmail: email,
      ...(has("commissioner") ? { leagueRole: "commissioner" as const } : {}),
    })
    .where(eq(schema.teamManagers.id, seat.id));

  console.log(`✓ ${seat.team.abbrev}: invite email set to ${email}`);
  if (has("commissioner")) console.log(`✓ ${seat.team.abbrev}: promoted to commissioner`);

  // If that person has already signed in, link them now rather than making them
  // sign out and back in for the claim-by-email path to fire.
  const existing = await db.query.users.findMany({
    where: sql`lower(${schema.users.email}) = ${email}`,
  });

  if (existing.length > 1) {
    console.log(
      `\n⚠ ${existing.length} user accounts share ${email}; not guessing which to link. ` +
        "Use the commissioner UI to assign one.",
    );
  } else if (existing.length === 1) {
    const user = existing[0];
    const clash = await db.query.teamManagers.findFirst({
      where: and(
        eq(schema.teamManagers.teamId, seat.teamId),
        eq(schema.teamManagers.userId, user.id),
      ),
    });
    if (clash && clash.id !== seat.id) {
      console.log(
        `\n⚠ ${user.displayName ?? email} already holds another seat on ${seat.team.abbrev}; left as is.`,
      );
    } else {
      await db
        .update(schema.teamManagers)
        .set({ userId: user.id })
        .where(eq(schema.teamManagers.id, seat.id));
      console.log(`✓ linked existing account ${user.displayName ?? email} — no re-login needed`);
    }
  } else {
    console.log("  (no account with that address yet; the seat claims itself on first sign-in)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
