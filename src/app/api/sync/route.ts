import { db } from "@/db";
import { requireCommissioner } from "@/lib/auth/membership";
import { credentialsFromEnv } from "@/lib/espn/client";
import { syncLeague } from "@/lib/espn/sync";
import { currentSeasonYear, ESPN_LEAGUE_ID, getLeague } from "@/lib/league";

export const dynamic = "force-dynamic";

/**
 * Commissioner-triggered ESPN sync.
 *
 * Authorization is enforced here, in the handler. Route handlers are not
 * covered by any path matcher we trust — see src/proxy.ts.
 */
export async function POST(request: Request) {
  try {
    await requireCommissioner();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return Response.json({ ok: false, error: message }, { status: 403 });
  }

  const credentials = credentialsFromEnv();
  if (!credentials) {
    return Response.json(
      {
        ok: false,
        error:
          "ESPN_S2 and ESPN_SWID are not set. This league is private, so a sync cannot run " +
          "without them. Copy them from a logged-in browser (DevTools → Application → Cookies → espn.com).",
      },
      { status: 400 },
    );
  }

  const league = await getLeague();
  const currentYear = currentSeasonYear();

  let years = [currentYear];
  try {
    const body = (await request.json()) as { years?: number[] };
    if (Array.isArray(body?.years) && body.years.length > 0) years = body.years;
  } catch {
    // No body is fine — default to the current season.
  }

  const results = await syncLeague(db, {
    leagueId: league.id,
    espnLeagueId: ESPN_LEAGUE_ID,
    currentYear,
    credentials,
    years,
  });

  const anyFailed = results.some((r) => r.result.status === "failed");
  return Response.json(
    { ok: !anyFailed, results },
    { status: anyFailed ? 502 : 200 },
  );
}
