import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect } from "vitest";

import * as schema from "@/db/schema";
import type { Db } from "@/db/types";

/**
 * Assert that a query was rejected by a specific database constraint.
 *
 * Drizzle wraps driver errors in a DrizzleQueryError whose `message` is only
 * the failed SQL — the constraint name lives on `cause`. Asserting on the
 * constraint name (rather than on "it threw") is what makes these tests
 * meaningful: a foreign-key typo would otherwise look like a passing test.
 */
export async function expectConstraintViolation(
  promise: Promise<unknown>,
  constraintName: string,
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught, `expected a constraint violation (${constraintName}), but the query succeeded`)
    .toBeDefined();

  const cause = (caught as { cause?: { constraint?: string; code?: string; message?: string } })
    .cause;

  expect(
    cause?.constraint,
    `expected constraint "${constraintName}", got "${cause?.constraint}" (SQLSTATE ${cause?.code}): ${cause?.message}`,
  ).toBe(constraintName);
}

/**
 * A throwaway in-memory Postgres with the real migrations applied.
 *
 * PGlite is actual Postgres compiled to WASM, not a mock — CHECK constraints,
 * unique indexes and transactions all behave exactly as they will on Neon.
 * That matters here because the schema pushes a lot of integrity down into the
 * database on purpose.
 */
export async function makeTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return { db: db as unknown as Db, client };
}

export const TEAM_ABBREVS = [
  "SACK",
  "BUES",
  "WFP",
  "NOVA",
  "DICK",
  "MAYE",
  "BYRN",
  "HULL",
  "cgm",
  "FLY",
  "DPK",
  "WW",
] as const;

/**
 * Minimal league fixture: 1 league, 12 teams, one season with a draft order and
 * a full pick scaffold. Returns lookup maps keyed by abbrev so tests can read
 * like the league talks ("WFP's 2027 3rd").
 */
export async function seedTestLeague(
  db: Db,
  opts: { year?: number; rounds?: number } = {},
) {
  const year = opts.year ?? 2027;
  const rounds = opts.rounds ?? 3;

  const [league] = await db
    .insert(schema.leagues)
    .values({ espnLeagueId: "718396", name: "NARC", teamCount: 12 })
    .returning();

  const teamRows = await db
    .insert(schema.teams)
    .values(
      TEAM_ABBREVS.map((abbrev, i) => ({
        leagueId: league.id,
        espnTeamId: i + 1,
        abbrev,
        name: `${abbrev} team`,
      })),
    )
    .returning();

  const [season] = await db
    .insert(schema.seasons)
    .values({ leagueId: league.id, year, draftRounds: rounds, isSnakeDraft: true })
    .returning();

  await db.insert(schema.draftOrder).values(
    teamRows.map((t, i) => ({
      seasonId: season.id,
      position: i + 1,
      baseTeamId: t.id,
      currentTeamId: t.id,
    })),
  );

  const pickRows = await db
    .insert(schema.draftPicks)
    .values(
      teamRows.flatMap((t) =>
        Array.from({ length: rounds }, (_, r) => ({
          seasonId: season.id,
          round: r + 1,
          originalTeamId: t.id,
          currentOwnerTeamId: t.id,
        })),
      ),
    )
    .returning();

  const [user] = await db
    .insert(schema.users)
    .values({ clerkUserId: "user_test_commish", email: "commish@narc.test", displayName: "Commish" })
    .returning();

  const team = Object.fromEntries(teamRows.map((t) => [t.abbrev, t])) as Record<
    (typeof TEAM_ABBREVS)[number],
    (typeof teamRows)[number]
  >;

  /** Look up a pick the way the league would say it: pick("WFP", 3). */
  const pick = (abbrev: (typeof TEAM_ABBREVS)[number], round: number) => {
    const found = pickRows.find((p) => p.originalTeamId === team[abbrev].id && p.round === round);
    if (!found) throw new Error(`no round-${round} pick for ${abbrev}`);
    return found;
  };

  return { league, season, teams: teamRows, team, picks: pickRows, pick, user };
}
