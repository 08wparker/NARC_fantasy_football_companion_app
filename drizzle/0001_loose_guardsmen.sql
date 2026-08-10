ALTER TABLE "seasons" ALTER COLUMN "base_keeper_slots" SET DEFAULT 3;--> statement-breakpoint
-- One-time backfill: the league keeps 3, not the 2 originally seeded.
-- Scoped to rows still holding the old default so a season deliberately set to
-- some other number (by ESPN sync reading keeperCount, or by hand) is untouched.
UPDATE "seasons" SET "base_keeper_slots" = 3 WHERE "base_keeper_slots" = 2;
