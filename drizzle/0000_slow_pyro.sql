CREATE TYPE "public"."league_role" AS ENUM('member', 'commissioner');--> statement-breakpoint
CREATE TYPE "public"."manager_role" AS ENUM('primary', 'co');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'open', 'passed', 'failed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trade_asset_kind" AS ENUM('draft_pick', 'player', 'keeper_right', 'keeper_slot', 'draft_slot_swap');--> statement-breakpoint
CREATE TYPE "public"."trade_event_action" AS ENUM('created', 'confirmed', 'rejected', 'cancelled', 'voided', 'noted');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('pending', 'confirmed', 'rejected', 'cancelled', 'voided');--> statement-breakpoint
CREATE TYPE "public"."vote_choice" AS ENUM('yes', 'no', 'abstain');--> statement-breakpoint
CREATE TABLE "draft_order" (
	"season_id" integer NOT NULL,
	"position" integer NOT NULL,
	"base_team_id" integer NOT NULL,
	"current_team_id" integer NOT NULL,
	CONSTRAINT "draft_order_season_id_position_pk" PRIMARY KEY("season_id","position"),
	CONSTRAINT "draft_order_position_positive" CHECK ("draft_order"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "draft_picks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "draft_picks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"round" integer NOT NULL,
	"original_team_id" integer NOT NULL,
	"current_owner_team_id" integer NOT NULL,
	"used_on_player_id" integer,
	"forfeited" boolean DEFAULT false NOT NULL,
	CONSTRAINT "draft_picks_round_positive" CHECK ("draft_picks"."round" >= 1)
);
--> statement-breakpoint
CREATE TABLE "espn_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "espn_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"league_id" integer NOT NULL,
	"espn_member_id" text NOT NULL,
	"display_name" text,
	"first_name" text,
	"last_name" text
);
--> statement-breakpoint
CREATE TABLE "espn_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "espn_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"espn_transaction_id" text NOT NULL,
	"type" text NOT NULL,
	"scoring_period_id" integer,
	"proposed_at" timestamp with time zone,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "leagues_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"espn_league_id" text NOT NULL,
	"name" text NOT NULL,
	"team_count" integer DEFAULT 12 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "players_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"espn_player_id" integer NOT NULL,
	"full_name" text NOT NULL,
	"default_position" text,
	"pro_team_abbrev" text,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "proposals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"league_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"proposed_by_user_id" integer NOT NULL,
	"proposed_by_team_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"opened_by_user_id" integer,
	"closes_at" timestamp with time zone,
	"eligible_voter_count" integer,
	"threshold_numerator" integer DEFAULT 2 NOT NULL,
	"threshold_denominator" integer DEFAULT 3 NOT NULL,
	"closed_at" timestamp with time zone,
	"effective_season_id" integer,
	CONSTRAINT "proposals_threshold_valid" CHECK ("proposals"."threshold_numerator" > 0 AND "proposals"."threshold_denominator" > 0 AND "proposals"."threshold_numerator" <= "proposals"."threshold_denominator"),
	CONSTRAINT "proposals_open_shape" CHECK (("proposals"."status" <> 'open') OR ("proposals"."opened_at" IS NOT NULL AND "proposals"."closes_at" IS NOT NULL AND "proposals"."eligible_voter_count" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "roster_spots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roster_spots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"acquisition_type" text,
	"draft_round_drafted" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seasons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"league_id" integer NOT NULL,
	"year" integer NOT NULL,
	"draft_rounds" integer DEFAULT 16 NOT NULL,
	"base_keeper_slots" integer DEFAULT 2 NOT NULL,
	"is_snake_draft" boolean DEFAULT true NOT NULL,
	"espn_is_active" boolean DEFAULT false NOT NULL,
	"standings_available" boolean DEFAULT false NOT NULL,
	"rosters_available" boolean DEFAULT false NOT NULL,
	"espn_status" jsonb,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "seasons_draft_rounds_positive" CHECK ("seasons"."draft_rounds" >= 1),
	CONSTRAINT "seasons_keeper_slots_nonneg" CHECK ("seasons"."base_keeper_slots" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"league_id" integer NOT NULL,
	"year" integer NOT NULL,
	"status" "sync_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "team_managers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "team_managers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"league_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"espn_member_id" integer,
	"user_id" integer,
	"role" "manager_role" DEFAULT 'primary' NOT NULL,
	"league_role" "league_role" DEFAULT 'member' NOT NULL,
	"invite_email" text,
	"display_name_override" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_seasons" (
	"season_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"name" text,
	"abbrev" text,
	"wins" integer,
	"losses" integer,
	"ties" integer,
	"points_for" integer,
	"points_against" integer,
	"final_rank" integer,
	CONSTRAINT "team_seasons_season_id_team_id_pk" PRIMARY KEY("season_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "teams_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"league_id" integer NOT NULL,
	"espn_team_id" integer NOT NULL,
	"abbrev" text NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"primary_espn_member_id" integer
);
--> statement-breakpoint
CREATE TABLE "trade_assets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trade_assets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trade_id" integer NOT NULL,
	"kind" "trade_asset_kind" NOT NULL,
	"from_team_id" integer NOT NULL,
	"to_team_id" integer NOT NULL,
	"draft_pick_id" integer,
	"player_id" integer,
	"season_id" integer,
	"slot_count" integer,
	"note" text,
	CONSTRAINT "trade_assets_distinct_parties" CHECK ("trade_assets"."from_team_id" <> "trade_assets"."to_team_id"),
	CONSTRAINT "trade_assets_slot_count_positive" CHECK ("trade_assets"."slot_count" IS NULL OR "trade_assets"."slot_count" >= 1),
	CONSTRAINT "trade_assets_kind_shape" CHECK (CASE "trade_assets"."kind"
            WHEN 'draft_pick'      THEN "trade_assets"."draft_pick_id" IS NOT NULL
                                    AND "trade_assets"."player_id" IS NULL AND "trade_assets"."slot_count" IS NULL
            WHEN 'player'          THEN "trade_assets"."player_id" IS NOT NULL
                                    AND "trade_assets"."draft_pick_id" IS NULL AND "trade_assets"."slot_count" IS NULL
            WHEN 'keeper_right'    THEN "trade_assets"."player_id" IS NOT NULL AND "trade_assets"."season_id" IS NOT NULL
                                    AND "trade_assets"."draft_pick_id" IS NULL AND "trade_assets"."slot_count" IS NULL
            WHEN 'keeper_slot'     THEN "trade_assets"."season_id" IS NOT NULL AND "trade_assets"."slot_count" IS NOT NULL
                                    AND "trade_assets"."draft_pick_id" IS NULL AND "trade_assets"."player_id" IS NULL
            WHEN 'draft_slot_swap' THEN "trade_assets"."season_id" IS NOT NULL
                                    AND "trade_assets"."draft_pick_id" IS NULL AND "trade_assets"."player_id" IS NULL
                                    AND "trade_assets"."slot_count" IS NULL
            ELSE false
          END)
);
--> statement-breakpoint
CREATE TABLE "trade_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trade_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trade_id" integer NOT NULL,
	"action" "trade_event_action" NOT NULL,
	"from_status" "trade_status",
	"to_status" "trade_status",
	"actor_user_id" integer,
	"actor_team_id" integer,
	"acted_as_commissioner" boolean DEFAULT false NOT NULL,
	"note" text,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trades_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"league_id" integer NOT NULL,
	"status" "trade_status" DEFAULT 'pending' NOT NULL,
	"logged_by_user_id" integer NOT NULL,
	"logged_by_team_id" integer NOT NULL,
	"agreed_on" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" integer,
	"confirmed_by_team_id" integer,
	"confirmed_by_commissioner" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" integer,
	"note" text,
	CONSTRAINT "trades_confirmed_shape" CHECK (("trades"."status" <> 'confirmed') OR ("trades"."confirmed_at" IS NOT NULL AND "trades"."confirmed_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"clerk_user_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "votes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"proposal_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"choice" "vote_choice" NOT NULL,
	"cast_by_user_id" integer NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_order" ADD CONSTRAINT "draft_order_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order" ADD CONSTRAINT "draft_order_base_team_id_teams_id_fk" FOREIGN KEY ("base_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order" ADD CONSTRAINT "draft_order_current_team_id_teams_id_fk" FOREIGN KEY ("current_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_original_team_id_teams_id_fk" FOREIGN KEY ("original_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_current_owner_team_id_teams_id_fk" FOREIGN KEY ("current_owner_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_used_on_player_id_players_id_fk" FOREIGN KEY ("used_on_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "espn_members" ADD CONSTRAINT "espn_members_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "espn_transactions" ADD CONSTRAINT "espn_transactions_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_proposed_by_team_id_teams_id_fk" FOREIGN KEY ("proposed_by_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_effective_season_id_seasons_id_fk" FOREIGN KEY ("effective_season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_spots" ADD CONSTRAINT "roster_spots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_spots" ADD CONSTRAINT "roster_spots_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_spots" ADD CONSTRAINT "roster_spots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_espn_member_id_espn_members_id_fk" FOREIGN KEY ("espn_member_id") REFERENCES "public"."espn_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_seasons" ADD CONSTRAINT "team_seasons_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_seasons" ADD CONSTRAINT "team_seasons_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_primary_espn_member_id_espn_members_id_fk" FOREIGN KEY ("primary_espn_member_id") REFERENCES "public"."espn_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_assets" ADD CONSTRAINT "trade_assets_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_assets" ADD CONSTRAINT "trade_assets_from_team_id_teams_id_fk" FOREIGN KEY ("from_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_assets" ADD CONSTRAINT "trade_assets_to_team_id_teams_id_fk" FOREIGN KEY ("to_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_assets" ADD CONSTRAINT "trade_assets_draft_pick_id_draft_picks_id_fk" FOREIGN KEY ("draft_pick_id") REFERENCES "public"."draft_picks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_assets" ADD CONSTRAINT "trade_assets_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_assets" ADD CONSTRAINT "trade_assets_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_actor_team_id_teams_id_fk" FOREIGN KEY ("actor_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_logged_by_user_id_users_id_fk" FOREIGN KEY ("logged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_logged_by_team_id_teams_id_fk" FOREIGN KEY ("logged_by_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_confirmed_by_team_id_teams_id_fk" FOREIGN KEY ("confirmed_by_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_cast_by_user_id_users_id_fk" FOREIGN KEY ("cast_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_order_season_current_team_uq" ON "draft_order" USING btree ("season_id","current_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_order_season_base_team_uq" ON "draft_order" USING btree ("season_id","base_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_picks_season_round_origin_uq" ON "draft_picks" USING btree ("season_id","round","original_team_id");--> statement-breakpoint
CREATE INDEX "draft_picks_owner_idx" ON "draft_picks" USING btree ("season_id","current_owner_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "espn_members_league_member_uq" ON "espn_members" USING btree ("league_id","espn_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "espn_transactions_season_espn_id_uq" ON "espn_transactions" USING btree ("season_id","espn_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leagues_espn_league_id_uq" ON "leagues" USING btree ("espn_league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_espn_player_id_uq" ON "players" USING btree ("espn_player_id");--> statement-breakpoint
CREATE INDEX "players_full_name_idx" ON "players" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "proposals_league_status_idx" ON "proposals" USING btree ("league_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_spots_season_team_player_uq" ON "roster_spots" USING btree ("season_id","team_id","player_id");--> statement-breakpoint
CREATE INDEX "roster_spots_season_player_idx" ON "roster_spots" USING btree ("season_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_league_year_uq" ON "seasons" USING btree ("league_id","year");--> statement-breakpoint
CREATE INDEX "sync_runs_league_year_idx" ON "sync_runs" USING btree ("league_id","year","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "team_managers_espn_member_uq" ON "team_managers" USING btree ("espn_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_managers_team_user_uq" ON "team_managers" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "team_managers_user_idx" ON "team_managers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_managers_invite_email_idx" ON "team_managers" USING btree ("league_id","invite_email");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_league_espn_team_uq" ON "teams" USING btree ("league_id","espn_team_id");--> statement-breakpoint
CREATE INDEX "trade_assets_trade_idx" ON "trade_assets" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trade_assets_pick_idx" ON "trade_assets" USING btree ("draft_pick_id");--> statement-breakpoint
CREATE INDEX "trade_assets_from_idx" ON "trade_assets" USING btree ("from_team_id");--> statement-breakpoint
CREATE INDEX "trade_assets_to_idx" ON "trade_assets" USING btree ("to_team_id");--> statement-breakpoint
CREATE INDEX "trade_events_trade_idx" ON "trade_events" USING btree ("trade_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_league_status_idx" ON "trades" USING btree ("league_id","status");--> statement-breakpoint
CREATE INDEX "trades_confirmed_at_idx" ON "trades" USING btree ("confirmed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_clerk_user_id_uq" ON "users" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_proposal_team_uq" ON "votes" USING btree ("proposal_id","team_id");--> statement-breakpoint
CREATE INDEX "votes_proposal_idx" ON "votes" USING btree ("proposal_id");