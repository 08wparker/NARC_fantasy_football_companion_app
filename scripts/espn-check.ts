/**
 * Are the ESPN cookies still good?
 *
 * espn_s2 / SWID rot on any ESPN logout or password change, and the only other
 * way to find out was to run the app, sign in as a commissioner, and click Sync
 * on /commissioner — which is a lot of ceremony to answer a yes/no question, and
 * impossible from CI or a fresh checkout.
 *
 * This hits the same fetchLeague() the sync uses, so a pass here means the sync
 * will authenticate. It touches no database.
 *
 *   npm run espn:check
 *   npm run espn:check -- --year 2025     # is an older season readable?
 */
import {
  credentialsFromEnv,
  EspnAuthError,
  EspnError,
  fetchLeague,
} from "@/lib/espn/client";
import { currentSeasonYear, ESPN_LEAGUE_ID } from "@/lib/league";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const credentials = credentialsFromEnv();
  if (!credentials) {
    const missing = [
      process.env.ESPN_S2 ? null : "ESPN_S2",
      process.env.ESPN_SWID ? null : "ESPN_SWID",
    ].filter(Boolean);
    console.error(
      `✗ ${missing.join(" and ")} not set in .env.local.\n` +
        "  This league is private, so no sync can run without them.\n" +
        "  Copy them from a logged-in browser: DevTools → Application → Cookies → espn.com.",
    );
    process.exit(1);
  }

  // Shape, not content — never log the values themselves. A SWID that lost its
  // braces on the way into .env.local is the single most common own-goal here,
  // and it presents as an indistinguishable 401.
  const braced = credentials.swid.startsWith("{") && credentials.swid.endsWith("}");
  console.log(
    `  credentials: espn_s2 ${credentials.espnS2.length} chars, ` +
      `SWID ${credentials.swid.length} chars ${braced ? "(braced ✓)" : "(NOT braced ✗)"}`,
  );
  if (!braced) {
    console.error(
      "✗ SWID must keep its surrounding { } braces. Without them ESPN returns 401.",
    );
    process.exit(1);
  }

  const yearArg = arg("year");
  const year = yearArg ? Number(yearArg) : currentSeasonYear();
  if (!Number.isInteger(year)) {
    console.error(`✗ --year expects a season year, got ${JSON.stringify(yearArg)}`);
    process.exit(1);
  }

  console.log(`  fetching league ${ESPN_LEAGUE_ID}, season ${year}…\n`);

  const league = await fetchLeague({ leagueId: ESPN_LEAGUE_ID, year, credentials });

  // A season ESPN has not reactivated answers 200 with isActive:false and zeroed
  // records. That is a status to report, not a failure — see client.ts.
  const active = league.status?.isActive;
  console.log(`✓ authenticated — ESPN accepted the cookies`);
  console.log(`    league     ${league.settings?.name ?? "(unnamed)"}`);
  console.log(`    season     ${league.seasonId ?? year}${active === false ? "  (dormant — not reactivated by ESPN)" : ""}`);
  console.log(`    teams      ${league.teams?.length ?? 0} (settings.size ${league.settings?.size ?? "?"})`);
  console.log(`    members    ${league.members?.length ?? 0}`);
  console.log(`    draft      ${league.settings?.draftSettings?.type ?? "?"}, keeperCount ${league.settings?.draftSettings?.keeperCount ?? "?"}`);
  if (league.status?.latestScoringPeriod !== undefined) {
    console.log(`    scoring pd ${league.status.latestScoringPeriod}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    if (error instanceof EspnAuthError) {
      console.error(`\n✗ ${error.message}`);
      console.error("  Re-copy espn_s2 and SWID into .env.local, then run this again.");
      process.exit(1);
    }
    if (error instanceof EspnError) {
      console.error(`\n✗ ${error.message}`);
      if (error.status === 404) {
        console.error("  A 404 usually means that season predates the league, or ESPN_LEAGUE_ID is wrong.");
      }
      process.exit(1);
    }
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
