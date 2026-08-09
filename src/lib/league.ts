import { cache } from "react";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";

/** This app serves exactly one league. */
export const ESPN_LEAGUE_ID = process.env.ESPN_LEAGUE_ID ?? "718396";

/**
 * React `cache()` dedupes this per request, so the dozen call sites that need
 * the league row cost one query per render, not a dozen.
 */
export const getLeague = cache(async () => {
  const league = await db.query.leagues.findFirst({
    where: eq(schema.leagues.espnLeagueId, ESPN_LEAGUE_ID),
  });
  if (!league) {
    throw new Error(
      `League ${ESPN_LEAGUE_ID} is not in the database yet. Run \`npm run db:seed\`.`,
    );
  }
  return league;
});

/** Current NFL season year. The league year rolls over in the spring. */
export function currentSeasonYear(now = new Date()) {
  // Treat Jan–Feb as still belonging to the previous season.
  const year = now.getUTCFullYear();
  return now.getUTCMonth() < 2 ? year - 1 : year;
}
