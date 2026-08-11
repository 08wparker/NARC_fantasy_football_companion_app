/**
 * NARC keeper-league schema.
 *
 * Three layers, deliberately separate:
 *
 *   1. ESPN mirror   — overwritten by sync, never hand-edited, never authoritative
 *                      for anything draft-related.
 *   2. Manual ledger — trades / trade_assets / trade_events / proposals / votes.
 *                      Append-only plus status transitions. This is the source of
 *                      truth, because ESPN's API has no representation for a
 *                      traded draft pick.
 *   3. Derived       — draft_picks.current_owner_team_id and
 *                      draft_order.current_team_id. Caches, rebuilt from layer 2.
 *
 * The invariant that keeps this honest: drop every derived column, recompute from
 * the ledger, and you get an identical database. See src/db/derive.ts.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ─────────────────────────────── enums ─────────────────────────────────── */

export const leagueRoleEnum = pgEnum("league_role", ["member", "commissioner"]);
export const managerRoleEnum = pgEnum("manager_role", ["primary", "co"]);

export const tradeStatusEnum = pgEnum("trade_status", [
  "pending", // logged by one side, awaiting counterparty or commissioner
  "confirmed", // authoritative; feeds derived state
  "rejected", // counterparty said no
  "cancelled", // proposer withdrew before confirmation
  "voided", // commissioner reversed a previously-confirmed trade
]);

export const tradeAssetKindEnum = pgEnum("trade_asset_kind", [
  "draft_pick",
  "player",
  "keeper_right",
  "keeper_slot",
  "draft_slot_swap",
]);

export const tradeEventActionEnum = pgEnum("trade_event_action", [
  "created",
  "confirmed",
  "rejected",
  "cancelled",
  "voided",
  "noted",
]);

export const proposalStatusEnum = pgEnum("proposal_status", [
  "draft",
  "open",
  "passed",
  "failed",
  "withdrawn",
]);

export const voteChoiceEnum = pgEnum("vote_choice", ["yes", "no", "abstain"]);
export const syncStatusEnum = pgEnum("sync_status", ["success", "partial", "failed"]);

/* ───────────────────────── identity & league ───────────────────────────── */

export const users = pgTable(
  "users",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_clerk_user_id_uq").on(t.clerkUserId),
    // Deliberately NOT unique. Identity is clerk_user_id; email is descriptive
    // metadata Clerk owns and can change, and two Clerk accounts can end up
    // sharing an address. A unique index here turns that edge case into a 500
    // on sign-in. Lookups by email (db:link, seat assignment) handle duplicates
    // by refusing to guess.
    index("users_email_idx").on(t.email),
  ],
);

export const leagues = pgTable(
  "leagues",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    espnLeagueId: text("espn_league_id").notNull(),
    name: text("name").notNull(),
    teamCount: integer("team_count").notNull().default(12),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("leagues_espn_league_id_uq").on(t.espnLeagueId)],
);

/**
 * One row per league-year. Holds the rule knobs that change year to year, plus
 * the liveness flags that stop the UI rendering 0-0 for a season ESPN has not
 * reactivated yet (2026 returns HTTP 200 with isActive:false and zeroed data).
 */
export const seasons = pgTable(
  "seasons",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),

    // rules snapshot
    draftRounds: integer("draft_rounds").notNull().default(16),
    baseKeeperSlots: integer("base_keeper_slots").notNull().default(3),
    isSnakeDraft: boolean("is_snake_draft").notNull().default(true),

    // ESPN liveness
    espnIsActive: boolean("espn_is_active").notNull().default(false),
    standingsAvailable: boolean("standings_available").notNull().default(false),
    rostersAvailable: boolean("rosters_available").notNull().default(false),
    espnStatus: jsonb("espn_status").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("seasons_league_year_uq").on(t.leagueId, t.year),
    check("seasons_draft_rounds_positive", sql`${t.draftRounds} >= 1`),
    check("seasons_keeper_slots_nonneg", sql`${t.baseKeeperSlots} >= 0`),
  ],
);

/* ───────────────────────────── ESPN mirror ─────────────────────────────── */

/**
 * ESPN's members[] — one row per ESPN account GUID. This is the join point that
 * makes co-managers tractable: team BUES genuinely has two member GUIDs
 * ("Rob Buesing" and "Robert Buesing"), and both can point at one app user.
 */
export const espnMembers = pgTable(
  "espn_members",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    espnMemberId: text("espn_member_id").notNull(), // "{ABC-123-...}"
    displayName: text("display_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
  },
  (t) => [uniqueIndex("espn_members_league_member_uq").on(t.leagueId, t.espnMemberId)],
);

/** Franchise identity — stable across seasons. */
export const teams = pgTable(
  "teams",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    espnTeamId: integer("espn_team_id").notNull(),
    abbrev: text("abbrev").notNull(),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    primaryEspnMemberId: integer("primary_espn_member_id").references(() => espnMembers.id),
  },
  (t) => [uniqueIndex("teams_league_espn_team_uq").on(t.leagueId, t.espnTeamId)],
);

/**
 * Per-year record. Record columns are nullable with NO default on purpose: a
 * dormant season must read as NULL ("—"), never as a real 0-0.
 */
export const teamSeasons = pgTable(
  "team_seasons",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name"),
    abbrev: text("abbrev"),
    wins: integer("wins"),
    losses: integer("losses"),
    ties: integer("ties"),
    pointsFor: integer("points_for"),
    pointsAgainst: integer("points_against"),
    finalRank: integer("final_rank"),
  },
  (t) => [primaryKey({ columns: [t.seasonId, t.teamId] })],
);

/**
 * Person ↔ franchise. A team can have several rows (co-managers).
 * userId is NULLABLE: managers exist in ESPN long before they sign into Clerk,
 * which is what lets the commissioner backfill the whole ledger solo.
 */
export const teamManagers = pgTable(
  "team_managers",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    espnMemberId: integer("espn_member_id").references(() => espnMembers.id, {
      onDelete: "set null",
    }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    role: managerRoleEnum("role").notNull().default("primary"),
    leagueRole: leagueRoleEnum("league_role").notNull().default("member"),
    inviteEmail: text("invite_email"), // pre-seeded; claimed on first Clerk sign-in
    displayNameOverride: text("display_name_override"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    // an ESPN member maps to at most one manager row
    uniqueIndex("team_managers_espn_member_uq").on(t.espnMemberId),
    // a user holds at most one seat per team (co-manager dedupe)
    uniqueIndex("team_managers_team_user_uq").on(t.teamId, t.userId),
    index("team_managers_user_idx").on(t.userId),
    index("team_managers_invite_email_idx").on(t.leagueId, t.inviteEmail),
  ],
);

export const players = pgTable(
  "players",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    /**
     * Nullable: the commissioner can enter a player by name when backfilling an
     * old trade, long before (or without ever) running an ESPN sync. Same
     * principle as team_managers.user_id — the ledger must work standalone, and
     * ESPN fills in identifiers later by matching on name.
     */
    espnPlayerId: integer("espn_player_id"),
    fullName: text("full_name").notNull(),
    defaultPosition: text("default_position"),
    proTeamAbbrev: text("pro_team_abbrev"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [
    // Still unique, but Postgres treats NULLs as distinct, so any number of
    // manually-entered players can coexist un-synced.
    uniqueIndex("players_espn_player_id_uq").on(t.espnPlayerId),
    index("players_full_name_idx").on(t.fullName),
  ],
);

/**
 * The league rulebook, as maintained by the commissioner.
 *
 * Deliberately separate from `proposals`. A proposal is a *vote* — a moment in
 * time with a tally and an outcome. A rule is the current state of the league's
 * law. Passing a proposal is how a rule usually changes, but the commissioner
 * also needs to write down rules that predate this app (keeper count, draft
 * format) without inventing a fake ballot for each one.
 */
export const rules = pgTable(
  "rules",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Set when a rule came from a passed ballot, so the two stay connected. */
    sourceProposalId: integer("source_proposal_id").references(() => proposals.id, {
      onDelete: "set null",
    }),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rules_league_sort_idx").on(t.leagueId, t.sortOrder),
    check("rules_body_not_blank", sql`length(btrim(${t.body})) > 0`),
  ],
);

export const rosterSpots = pgTable(
  "roster_spots",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    acquisitionType: text("acquisition_type"), // DRAFT | ADD | TRADE
    draftRoundDrafted: integer("draft_round_drafted"), // keeper-cost input
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("roster_spots_season_team_player_uq").on(t.seasonId, t.teamId, t.playerId),
    index("roster_spots_season_player_idx").on(t.seasonId, t.playerId),
  ],
);

/** Raw ESPN transaction items — mirror only, never the ledger. */
export const espnTransactions = pgTable(
  "espn_transactions",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    espnTransactionId: text("espn_transaction_id").notNull(),
    type: text("type").notNull(),
    scoringPeriodId: integer("scoring_period_id"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    payload: jsonb("payload").$type<unknown>().notNull(),
  },
  (t) => [uniqueIndex("espn_transactions_season_espn_id_uq").on(t.seasonId, t.espnTransactionId)],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    status: syncStatusEnum("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    counts: jsonb("counts").$type<Record<string, number>>(),
    error: text("error"),
  },
  (t) => [index("sync_runs_league_year_idx").on(t.leagueId, t.year, t.startedAt)],
);

/* ──────────────────── draft picks & draft order (derived) ───────────────── */

/**
 * Pick identity is (season, round, originalTeam). Deliberately NO pick number:
 * board position is a function of draft_order, which slot swaps mutate. That
 * orthogonality is what lets a slot swap move a team's picks as a group while a
 * pick trade changes a single owner, without either knowing about the other.
 *
 * currentOwnerTeamId is the ONLY materialized derivation. Rebuildable.
 */
export const draftPicks = pgTable(
  "draft_picks",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    originalTeamId: integer("original_team_id")
      .notNull()
      .references(() => teams.id),
    currentOwnerTeamId: integer("current_owner_team_id")
      .notNull()
      .references(() => teams.id),
    usedOnPlayerId: integer("used_on_player_id").references(() => players.id),
    forfeited: boolean("forfeited").notNull().default(false),
  },
  (t) => [
    uniqueIndex("draft_picks_season_round_origin_uq").on(t.seasonId, t.round, t.originalTeamId),
    index("draft_picks_owner_idx").on(t.seasonId, t.currentOwnerTeamId),
    check("draft_picks_round_positive", sql`${t.round} >= 1`),
  ],
);

/**
 * baseTeamId  = order as set by the commissioner / ESPN lottery.
 * currentTeamId = after confirmed slot swaps. Also rebuildable.
 *
 * The two unique indexes are load-bearing: they turn a botched swap (two teams
 * landing on one slot) into a database error instead of a draft-night mystery.
 */
export const draftOrder = pgTable(
  "draft_order",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    position: integer("position").notNull(), // 1..teamCount
    baseTeamId: integer("base_team_id")
      .notNull()
      .references(() => teams.id),
    currentTeamId: integer("current_team_id")
      .notNull()
      .references(() => teams.id),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.position] }),
    uniqueIndex("draft_order_season_current_team_uq").on(t.seasonId, t.currentTeamId),
    uniqueIndex("draft_order_season_base_team_uq").on(t.seasonId, t.baseTeamId),
    check("draft_order_position_positive", sql`${t.position} >= 1`),
  ],
);

/* ───────────────────────────── the ledger ──────────────────────────────── */

export const trades = pgTable(
  "trades",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    status: tradeStatusEnum("status").notNull().default("pending"),

    loggedByUserId: integer("logged_by_user_id")
      .notNull()
      .references(() => users.id),
    loggedByTeamId: integer("logged_by_team_id")
      .notNull()
      .references(() => teams.id),

    agreedOn: timestamp("agreed_on", { withTimezone: true }), // real-world handshake date
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedByUserId: integer("confirmed_by_user_id").references(() => users.id),
    confirmedByTeamId: integer("confirmed_by_team_id").references(() => teams.id),
    confirmedByCommissioner: boolean("confirmed_by_commissioner").notNull().default(false),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }), // reject / cancel / void
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),

    note: text("note"),
  },
  (t) => [
    index("trades_league_status_idx").on(t.leagueId, t.status),
    index("trades_confirmed_at_idx").on(t.confirmedAt),
    // a confirmed trade must carry its confirmation metadata
    check(
      "trades_confirmed_shape",
      sql`(${t.status} <> 'confirmed') OR (${t.confirmedAt} IS NOT NULL AND ${t.confirmedByUserId} IS NOT NULL)`,
    ),
  ],
);

/**
 * IMMUTABLE. Insert-only — there is no UPDATE path in the app. Corrections are
 * status transitions on the parent trade, never edits here.
 *
 * from/to live on the asset (not the trade) so three-way trades need no extra
 * modeling and each leg is independently explainable.
 */
export const tradeAssets = pgTable(
  "trade_assets",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    tradeId: integer("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    kind: tradeAssetKindEnum("kind").notNull(),

    fromTeamId: integer("from_team_id")
      .notNull()
      .references(() => teams.id),
    toTeamId: integer("to_team_id")
      .notNull()
      .references(() => teams.id),

    // kind = 'draft_pick'
    draftPickId: integer("draft_pick_id").references(() => draftPicks.id),

    // kind = 'player' | 'keeper_right'
    playerId: integer("player_id").references(() => players.id),

    // kind = 'keeper_right' | 'keeper_slot' | 'draft_slot_swap'
    seasonId: integer("season_id").references(() => seasons.id),

    // kind = 'keeper_slot'
    slotCount: integer("slot_count"),

    note: text("note"),
  },
  (t) => [
    index("trade_assets_trade_idx").on(t.tradeId),
    index("trade_assets_pick_idx").on(t.draftPickId),
    index("trade_assets_from_idx").on(t.fromTeamId),
    index("trade_assets_to_idx").on(t.toTeamId),
    check("trade_assets_distinct_parties", sql`${t.fromTeamId} <> ${t.toTeamId}`),
    check("trade_assets_slot_count_positive", sql`${t.slotCount} IS NULL OR ${t.slotCount} >= 1`),
    /**
     * The discriminant contract, enforced by Postgres rather than by a Zod
     * schema someone forgets to run.
     *
     * NOTE: if you add a sixth asset kind, extend this CASE in the same
     * migration. A CASE with no ELSE evaluates to NULL for an unmatched kind,
     * and a NULL CHECK *passes* — so it would fail open, silently.
     */
    check(
      "trade_assets_kind_shape",
      sql`CASE ${t.kind}
            WHEN 'draft_pick'      THEN ${t.draftPickId} IS NOT NULL
                                    AND ${t.playerId} IS NULL AND ${t.slotCount} IS NULL
            WHEN 'player'          THEN ${t.playerId} IS NOT NULL
                                    AND ${t.draftPickId} IS NULL AND ${t.slotCount} IS NULL
            WHEN 'keeper_right'    THEN ${t.playerId} IS NOT NULL AND ${t.seasonId} IS NOT NULL
                                    AND ${t.draftPickId} IS NULL AND ${t.slotCount} IS NULL
            WHEN 'keeper_slot'     THEN ${t.seasonId} IS NOT NULL AND ${t.slotCount} IS NOT NULL
                                    AND ${t.draftPickId} IS NULL AND ${t.playerId} IS NULL
            WHEN 'draft_slot_swap' THEN ${t.seasonId} IS NOT NULL
                                    AND ${t.draftPickId} IS NULL AND ${t.playerId} IS NULL
                                    AND ${t.slotCount} IS NULL
            ELSE false
          END`,
    ),
  ],
);

/** Append-only audit trail. Never updated, never deleted. */
export const tradeEvents = pgTable(
  "trade_events",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    tradeId: integer("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    action: tradeEventActionEnum("action").notNull(),
    fromStatus: tradeStatusEnum("from_status"),
    toStatus: tradeStatusEnum("to_status"),
    actorUserId: integer("actor_user_id").references(() => users.id),
    actorTeamId: integer("actor_team_id").references(() => teams.id),
    actedAsCommissioner: boolean("acted_as_commissioner").notNull().default(false),
    note: text("note"),
    snapshot: jsonb("snapshot").$type<unknown>(), // asset list at time of event
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trade_events_trade_idx").on(t.tradeId, t.createdAt)],
);

/* ───────────────────────── rule-change proposals ───────────────────────── */

export const proposals = pgTable(
  "proposals",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: proposalStatusEnum("status").notNull().default("draft"),

    proposedByUserId: integer("proposed_by_user_id")
      .notNull()
      .references(() => users.id),
    proposedByTeamId: integer("proposed_by_team_id").references(() => teams.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Snapshotted when the commissioner opens voting, so pass math stays
    // deterministic even if the league later changes size.
    openedAt: timestamp("opened_at", { withTimezone: true }),
    openedByUserId: integer("opened_by_user_id").references(() => users.id),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    eligibleVoterCount: integer("eligible_voter_count"),
    thresholdNumerator: integer("threshold_numerator").notNull().default(2),
    thresholdDenominator: integer("threshold_denominator").notNull().default(3),

    closedAt: timestamp("closed_at", { withTimezone: true }),
    effectiveSeasonId: integer("effective_season_id").references(() => seasons.id),
  },
  (t) => [
    index("proposals_league_status_idx").on(t.leagueId, t.status),
    check(
      "proposals_threshold_valid",
      sql`${t.thresholdNumerator} > 0 AND ${t.thresholdDenominator} > 0 AND ${t.thresholdNumerator} <= ${t.thresholdDenominator}`,
    ),
    check(
      "proposals_open_shape",
      sql`(${t.status} <> 'open') OR (${t.openedAt} IS NOT NULL AND ${t.closesAt} IS NOT NULL AND ${t.eligibleVoterCount} IS NOT NULL)`,
    ),
  ],
);

/**
 * One ballot per FRANCHISE per proposal — keyed on team, not user.
 *
 * Team BUES has two ESPN member GUIDs. Keying on user would let one franchise
 * cast two ballots and silently drift the denominator. castByUserId records
 * which co-manager actually pressed the button.
 */
export const votes = pgTable(
  "votes",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    choice: voteChoiceEnum("choice").notNull(),
    castByUserId: integer("cast_by_user_id")
      .notNull()
      .references(() => users.id),
    castAt: timestamp("cast_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("votes_proposal_team_uq").on(t.proposalId, t.teamId),
    index("votes_proposal_idx").on(t.proposalId),
  ],
);

/* ──────────────────────────── relations ────────────────────────────────── */

export const leaguesRelations = relations(leagues, ({ many }) => ({
  rules: many(rules),
  seasons: many(seasons),
  teams: many(teams),
  espnMembers: many(espnMembers),
  trades: many(trades),
  proposals: many(proposals),
}));

export const seasonsRelations = relations(seasons, ({ one, many }) => ({
  league: one(leagues, { fields: [seasons.leagueId], references: [leagues.id] }),
  draftPicks: many(draftPicks),
  draftOrder: many(draftOrder),
  teamSeasons: many(teamSeasons),
  rosterSpots: many(rosterSpots),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  league: one(leagues, { fields: [teams.leagueId], references: [leagues.id] }),
  primaryEspnMember: one(espnMembers, {
    fields: [teams.primaryEspnMemberId],
    references: [espnMembers.id],
  }),
  managers: many(teamManagers),
  teamSeasons: many(teamSeasons),
  votes: many(votes),
}));

export const espnMembersRelations = relations(espnMembers, ({ one, many }) => ({
  league: one(leagues, { fields: [espnMembers.leagueId], references: [leagues.id] }),
  managers: many(teamManagers),
}));

export const teamManagersRelations = relations(teamManagers, ({ one }) => ({
  team: one(teams, { fields: [teamManagers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamManagers.userId], references: [users.id] }),
  espnMember: one(espnMembers, {
    fields: [teamManagers.espnMemberId],
    references: [espnMembers.id],
  }),
}));

export const teamSeasonsRelations = relations(teamSeasons, ({ one }) => ({
  season: one(seasons, { fields: [teamSeasons.seasonId], references: [seasons.id] }),
  team: one(teams, { fields: [teamSeasons.teamId], references: [teams.id] }),
}));

export const rosterSpotsRelations = relations(rosterSpots, ({ one }) => ({
  season: one(seasons, { fields: [rosterSpots.seasonId], references: [seasons.id] }),
  team: one(teams, { fields: [rosterSpots.teamId], references: [teams.id] }),
  player: one(players, { fields: [rosterSpots.playerId], references: [players.id] }),
}));

export const draftPicksRelations = relations(draftPicks, ({ one, many }) => ({
  season: one(seasons, { fields: [draftPicks.seasonId], references: [seasons.id] }),
  originalTeam: one(teams, {
    relationName: "pickOriginalTeam",
    fields: [draftPicks.originalTeamId],
    references: [teams.id],
  }),
  currentOwner: one(teams, {
    relationName: "pickCurrentOwner",
    fields: [draftPicks.currentOwnerTeamId],
    references: [teams.id],
  }),
  tradeAssets: many(tradeAssets), // provenance chain
}));

export const draftOrderRelations = relations(draftOrder, ({ one }) => ({
  season: one(seasons, { fields: [draftOrder.seasonId], references: [seasons.id] }),
  baseTeam: one(teams, {
    relationName: "slotBaseTeam",
    fields: [draftOrder.baseTeamId],
    references: [teams.id],
  }),
  currentTeam: one(teams, {
    relationName: "slotCurrentTeam",
    fields: [draftOrder.currentTeamId],
    references: [teams.id],
  }),
}));

export const tradesRelations = relations(trades, ({ one, many }) => ({
  league: one(leagues, { fields: [trades.leagueId], references: [leagues.id] }),
  assets: many(tradeAssets),
  events: many(tradeEvents),
  loggedByTeam: one(teams, {
    relationName: "tradeLoggedByTeam",
    fields: [trades.loggedByTeamId],
    references: [teams.id],
  }),
  loggedByUser: one(users, {
    relationName: "tradeLoggedByUser",
    fields: [trades.loggedByUserId],
    references: [users.id],
  }),
}));

export const tradeAssetsRelations = relations(tradeAssets, ({ one }) => ({
  trade: one(trades, { fields: [tradeAssets.tradeId], references: [trades.id] }),
  draftPick: one(draftPicks, {
    fields: [tradeAssets.draftPickId],
    references: [draftPicks.id],
  }),
  player: one(players, { fields: [tradeAssets.playerId], references: [players.id] }),
  season: one(seasons, { fields: [tradeAssets.seasonId], references: [seasons.id] }),
  fromTeam: one(teams, {
    relationName: "assetFromTeam",
    fields: [tradeAssets.fromTeamId],
    references: [teams.id],
  }),
  toTeam: one(teams, {
    relationName: "assetToTeam",
    fields: [tradeAssets.toTeamId],
    references: [teams.id],
  }),
}));

export const tradeEventsRelations = relations(tradeEvents, ({ one }) => ({
  trade: one(trades, { fields: [tradeEvents.tradeId], references: [trades.id] }),
  actorUser: one(users, { fields: [tradeEvents.actorUserId], references: [users.id] }),
  actorTeam: one(teams, { fields: [tradeEvents.actorTeamId], references: [teams.id] }),
}));

export const proposalsRelations = relations(proposals, ({ one, many }) => ({
  league: one(leagues, { fields: [proposals.leagueId], references: [leagues.id] }),
  votes: many(votes),
  proposedByUser: one(users, {
    relationName: "proposalAuthor",
    fields: [proposals.proposedByUserId],
    references: [users.id],
  }),
}));

export const votesRelations = relations(votes, ({ one }) => ({
  proposal: one(proposals, { fields: [votes.proposalId], references: [proposals.id] }),
  team: one(teams, { fields: [votes.teamId], references: [teams.id] }),
  castBy: one(users, { fields: [votes.castByUserId], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  managerSeats: many(teamManagers),
}));

export const rulesRelations = relations(rules, ({ one }) => ({
  league: one(leagues, { fields: [rules.leagueId], references: [leagues.id] }),
  sourceProposal: one(proposals, {
    fields: [rules.sourceProposalId],
    references: [proposals.id],
  }),
  createdBy: one(users, { fields: [rules.createdByUserId], references: [users.id] }),
}));
