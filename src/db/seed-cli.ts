/**
 * CLI wrapper around seedLeague().
 *
 *   npm run db:seed
 *
 * Kept separate from seed.ts so the seeding logic can be exercised against
 * PGlite in tests without needing a DATABASE_URL.
 */
import { db } from "./index";
import { seedLeague } from "./seed";

const espnLeagueId = process.env.ESPN_LEAGUE_ID ?? "718396";
const currentYear = Number(process.env.SEED_CURRENT_YEAR ?? new Date().getUTCFullYear());

seedLeague(db, { espnLeagueId, currentYear })
  .then(({ league, seasons, unlinkedSeatCount, prunedSeasons, keptSeasons, ruleCount }) => {
    console.log(`✓ League ${league.name} (ESPN ${espnLeagueId}) — 12 teams`);
    console.log(`✓ Seasons scaffolded: ${seasons.map((s) => s.year).join(", ")}`);
    console.log(`  ${unlinkedSeatCount} manager seats awaiting a Clerk sign-in`);
    console.log(`✓ ${ruleCount} league rules on record`);
    if (prunedSeasons.length > 0) {
      console.log(`✓ Pruned seasons beyond the trade horizon: ${prunedSeasons.join(", ")}`);
    }
    for (const k of keptSeasons) {
      console.log(`  ! Kept ${k.year} — ${k.reason}`);
    }
    console.log(
      "\nNext: set invite emails for the other managers, then invite them from the Clerk dashboard.",
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
