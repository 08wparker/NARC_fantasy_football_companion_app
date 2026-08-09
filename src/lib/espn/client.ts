import { z } from "zod";

/**
 * ESPN Fantasy v3 read client.
 *
 * Facts this encodes, all verified against the live API:
 *  - The host is lm-api-reads.fantasy.espn.com. The old fantasy.espn.com host
 *    302s to an HTML landing page.
 *  - leagueHistory?seasonId= now 404s; use per-season URLs for every year.
 *  - A private league returns 401 unauthenticated. NARC is private.
 *  - A season ESPN has not reactivated returns HTTP 200 with
 *    status.isActive:false and zeroed records — NOT an error. Detecting
 *    dormancy by status code would silently render everyone 0-0.
 *  - mTransactions2 omits the `transactions` key entirely unless you send BOTH
 *    scoringPeriodId and an x-fantasy-filter header.
 */

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

export class EspnAuthError extends Error {
  constructor() {
    super(
      "ESPN rejected the credentials (401). The espn_s2 / SWID cookies have expired — " +
        "sign in to ESPN in a browser and re-copy them.",
    );
    this.name = "EspnAuthError";
  }
}

export class EspnError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EspnError";
  }
}

export type EspnCredentials = { espnS2: string; swid: string };

export function credentialsFromEnv(): EspnCredentials | null {
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;
  if (!espnS2 || !swid) return null;
  return { espnS2, swid };
}

/* ─────────────────────────────── schemas ───────────────────────────────── */

// Everything is .passthrough()/optional on purpose: ESPN adds and removes
// fields without notice, and a strict schema would turn a cosmetic API change
// into a total sync outage.

const statusSchema = z
  .object({
    isActive: z.boolean().optional(),
    activatedDate: z.number().optional(),
    latestScoringPeriod: z.number().optional(),
    currentMatchupPeriod: z.number().optional(),
    previousSeasons: z.array(z.number()).optional(),
    teamsJoined: z.number().optional(),
  })
  .loose();

const memberSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  })
  .loose();

const recordEntrySchema = z
  .object({
    wins: z.number().optional(),
    losses: z.number().optional(),
    ties: z.number().optional(),
    pointsFor: z.number().optional(),
    pointsAgainst: z.number().optional(),
  })
  .loose();

const teamSchema = z
  .object({
    id: z.number(),
    abbrev: z.string().optional(),
    name: z.string().optional(),
    logo: z.string().optional(),
    owners: z.array(z.string()).optional(),
    primaryOwner: z.string().optional(),
    playoffSeed: z.number().optional(),
    rankCalculatedFinal: z.number().optional(),
    record: z.object({ overall: recordEntrySchema.optional() }).loose().optional(),
    roster: z
      .object({
        entries: z
          .array(
            z
              .object({
                playerId: z.number(),
                acquisitionType: z.string().nullable().optional(),
                playerPoolEntry: z
                  .object({
                    player: z
                      .object({
                        id: z.number().optional(),
                        fullName: z.string().optional(),
                        defaultPositionId: z.number().optional(),
                        proTeamId: z.number().optional(),
                      })
                      .loose()
                      .optional(),
                  })
                  .loose()
                  .optional(),
              })
              .loose(),
          )
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export const leagueResponseSchema = z
  .object({
    id: z.number().optional(),
    seasonId: z.number().optional(),
    status: statusSchema.optional(),
    settings: z
      .object({
        name: z.string().optional(),
        size: z.number().optional(),
        draftSettings: z
          .object({
            keeperCount: z.number().optional(),
            pickOrder: z.array(z.number()).optional(),
            type: z.string().optional(),
          })
          .loose()
          .optional(),
        rosterSettings: z.object({}).loose().optional(),
      })
      .loose()
      .optional(),
    members: z.array(memberSchema).optional(),
    teams: z.array(teamSchema).optional(),
  })
  .loose();

export type EspnLeagueResponse = z.infer<typeof leagueResponseSchema>;

/* ─────────────────────────────── fetching ──────────────────────────────── */

async function get(
  path: string,
  opts: {
    credentials?: EspnCredentials | null;
    searchParams?: Record<string, string | number | undefined>;
    fantasyFilter?: unknown;
  } = {},
): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
    if (v !== undefined) url.searchParams.append(k, String(v));
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.credentials) {
    // SWID keeps its braces; espn_s2 stays URL-encoded as copied from the browser.
    headers.Cookie = `espn_s2=${opts.credentials.espnS2}; SWID=${opts.credentials.swid}`;
  }
  if (opts.fantasyFilter) {
    headers["x-fantasy-filter"] = JSON.stringify(opts.fantasyFilter);
  }

  const response = await fetch(url, { headers, cache: "no-store" });

  if (response.status === 401) throw new EspnAuthError();
  if (!response.ok) {
    throw new EspnError(
      `ESPN returned ${response.status} for ${url.pathname}${url.search}`,
      response.status,
    );
  }

  return response.json();
}

const VIEWS = ["mTeam", "mRoster", "mSettings", "mDraftDetail"] as const;

/** Full league snapshot for a season. Views are additive. */
export async function fetchLeague(opts: {
  leagueId: string;
  year: number;
  credentials?: EspnCredentials | null;
  views?: readonly string[];
}): Promise<EspnLeagueResponse> {
  const url = new URL(`${BASE}/seasons/${opts.year}/segments/0/leagues/${opts.leagueId}`);
  for (const view of opts.views ?? VIEWS) url.searchParams.append("view", view);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.credentials) {
    headers.Cookie = `espn_s2=${opts.credentials.espnS2}; SWID=${opts.credentials.swid}`;
  }

  const response = await fetch(url, { headers, cache: "no-store" });
  if (response.status === 401) throw new EspnAuthError();
  if (!response.ok) {
    throw new EspnError(`ESPN returned ${response.status} for season ${opts.year}`, response.status);
  }

  return leagueResponseSchema.parse(await response.json());
}

/**
 * Raw transactions for a season.
 *
 * Note the caller should treat these as a MIRROR only. A TRADE_ACCEPT carries
 * no `items` array and its relatedTransactionId does not resolve to anything in
 * the feed, so completed trades cannot be reliably reconstructed from here.
 * Draft picks have no representation at all. That is precisely why this app
 * keeps its own ledger.
 */
export async function fetchTransactions(opts: {
  leagueId: string;
  year: number;
  credentials?: EspnCredentials | null;
  scoringPeriods?: number[];
}): Promise<Array<Record<string, unknown>>> {
  const periods = opts.scoringPeriods ?? Array.from({ length: 19 }, (_, i) => i);
  const all: Array<Record<string, unknown>> = [];

  for (const scoringPeriodId of periods) {
    const payload = (await get(`/seasons/${opts.year}/segments/0/leagues/${opts.leagueId}`, {
      credentials: opts.credentials,
      searchParams: { view: "mTransactions2", scoringPeriodId },
      // Without BOTH this header and scoringPeriodId, the `transactions` key
      // is silently absent from the response.
      fantasyFilter: {
        transactions: {
          filterType: {
            value: [
              "TRADE_ACCEPT",
              "TRADE_PROPOSAL",
              "TRADE_UPHOLD",
              "WAIVER",
              "FREEAGENT",
              "DRAFT",
              "ROSTER",
            ],
          },
        },
      },
    })) as { transactions?: Array<Record<string, unknown>> };

    if (Array.isArray(payload?.transactions)) all.push(...payload.transactions);
  }

  return all;
}

/** Seasons ESPN itself says exist, plus the requested one. Never guess years. */
export function availableSeasons(response: EspnLeagueResponse, requestedYear: number): number[] {
  const previous = response.status?.previousSeasons ?? [];
  return [...new Set([...previous, requestedYear])].sort((a, b) => a - b);
}

/**
 * A season is dormant when ESPN has not reactivated it. Detected from the body,
 * never the status code — a dormant season is a perfectly ordinary 200.
 */
export function isDormant(response: EspnLeagueResponse): boolean {
  const status = response.status;
  if (!status) return true;
  if (status.isActive === false) return true;
  return status.activatedDate === undefined;
}
