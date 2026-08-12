<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# NARC Fantasy Football Companion

Companion app for the North Adams Rowing Club, a 12-team ESPN keeper league
(leagueId `718396`). Two jobs:

1. **Remember trades that affect a future draft** — round picks, draft slot
   swaps, and players.
2. **Run the rulebook** — standing rules plus rule-change votes.

Live at <https://narc-fantasy-football.vercel.app>.

## Why this app exists

ESPN's API **cannot represent a traded draft pick.** Verified against the live
API: transaction item types are exactly `{ADD, DROP, TRADE, DRAFT, LINEUP}` and
every one is keyed on `playerId`. ESPN's UI only supports trading *current
season* picks and never future years. On top of that, `TRADE_ACCEPT`
transactions carry **no `items` array** and their `relatedTransactionId`
resolves to nothing in the feed.

So this app's ledger is the **authoritative record**. ESPN is a read-only mirror
for team/roster context and nothing more.

Two environmental facts:
- **The league is private.** Every ESPN season endpoint returns `401` without
  `espn_s2` + `SWID` cookies. They stay server-side only.
- **A non-reactivated season returns HTTP 200**, with `status.isActive: false`
  and zeroed records. Detecting dormancy by status code would render everyone
  as a real 0-0.

## Commands

```bash
npm run dev          # dev server
npm run build        # production build
npm test             # vitest — 146 tests, all against real Postgres (PGlite/WASM)
npm run typecheck    # run `npx next typegen` first on a cold checkout
npm run verify       # end-to-end checks against a REAL Postgres server
npm run espn:check   # are the espn_s2/SWID cookies still good? `-- --year 2025`
npm run db:generate  # generate a migration from src/db/schema.ts
npm run db:migrate   # apply migrations
npm run db:seed      # idempotent: league, 12 teams, tradeable seasons, rulebook
npm run db:link      # manager seats from the CLI — see "Onboarding" below
npm run db:studio    # drizzle studio
```

## What can and cannot be traded

The league's rules are enforced in `validateTradeAssets`
(`src/db/trade-logic.ts`), not merely documented:

| Asset | Tradeable | Why |
|---|---|---|
| `draft_pick` | yes, current + next season only | Picks further out are never scaffolded, so they cannot be picked by accident |
| `player` | yes | Keeper rights travel with them implicitly |
| `draft_slot_swap` | yes | Exchanges two teams' board positions for a season |
| `keeper_right` | **no** | Rights follow the player; they never move alone |
| `keeper_slot` | **no** | Every team keeps the same number |

Both keeper enum values survive so historical rows stay readable — only new
writes are refused. Rejection happens before the insert, so a banned asset
smuggled into an otherwise legal multi-asset trade rejects the *whole* trade
rather than silently dropping one leg.

## Onboarding managers

A person becomes a manager by **claiming a seat**. Seats exist in
`team_managers` from the seed with `user_id` NULL; on first sign-in
`syncClerkUser` matches the Clerk email against `invite_email`
(case-insensitively) and fills in `user_id`.

So the only thing between a manager and access is an invite email. Set them on
the commissioner page, or from the CLI:

```bash
npm run db:link -- --list                                          # who is where
npm run db:link -- --email wparker@uchicago.edu --team WFP --commissioner
npm run db:link -- --email tyler@example.com --team HULL
```

The CLI exists because the seat UI requires you to already *be* a commissioner,
which is circular before anyone has claimed one. It also retro-links a user who
has already signed in, so they don't have to sign out and back in.

Two rules worth knowing:

- **At most one seat per franchise per person.** A co-managed team has several
  seats (BUES has two, because ESPN lists "Rob Buesing" and "Robert Buesing"
  separately). If both carry the same invite email, only the first is claimed —
  otherwise `team_managers_team_user_uq` rejects the write and 500s the sign-in,
  and the franchise would end up holding two ballots.
- **The last commissioner cannot be demoted, unlinked or deactivated.** Enforced
  in `src/db/manager-service.ts`, not just the UI. Self-demotion is a real
  workflow (hand the role to the LM, then step down) and doing those two steps in
  the wrong order would lock the league out with no way back.

A commissioner seat only counts if a live user holds it — an unclaimed or
deactivated one confers nothing and does not satisfy the guard.

## Architecture

Three layers, deliberately separate. The invariant: **drop every derived column,
recompute from the ledger, and you get an identical database.**

| Layer | Source of truth | Mutability |
|---|---|---|
| ESPN mirror — `teams`, `team_seasons`, `espn_members`, `players`, `roster_spots`, `espn_transactions`, `sync_runs` | ESPN | upsert-only, never deleted, never hand-edited |
| Ledger — `trades`, `trade_assets`, `trade_events`, `proposals`, `votes`, `rules` | this app | append-only + status transitions |
| Derived — `draft_picks.current_owner_team_id`, `draft_order.current_team_id` | computed | rebuildable from scratch |

### Key files

- `src/db/schema.ts` — the whole model, with integrity pushed into Postgres
- `src/db/derive.ts` — `rebuildDerivedState`, the correctness core
- `src/db/trade-logic.ts` — asset shapes and the league's trade rules
- `src/db/trade-service.ts` — the trade state machine
- `src/db/proposal-service.ts` — voting and tallying
- `src/db/rules-service.ts` — the rulebook, and `DEFAULT_RULES`
- `src/db/manager-service.ts` — seats, roles, last-commissioner guard
- `src/db/player-service.ts` — find-or-create players by name
- `src/db/picks.ts` — season scaffolding and the trade horizon
- `src/db/queries.ts` — draft board (snake math), provenance, history
- `src/lib/espn/{client,sync}.ts` — the mirror
- `src/lib/espn/draft.ts` — draft recap, read live from ESPN and cached
- `src/lib/auth/membership.ts` — the single authorization entry point
- `src/proxy.ts` — Clerk middleware (Next 16 renamed `middleware.ts`)

### Rules that are load-bearing

- **The draft *recap* is not mirrored, unlike everything else from ESPN.**
  `/draft-results` fetches `mDraftDetail` live and caches it (`unstable_cache`,
  1 hour) instead of writing a table. A completed draft is immutable, so there
  is nothing for the ledger to contradict and a mirror table could only ever be
  a copy. Note the naming: **draft board = who owns which future pick** (the
  ledger), **draft results = what was actually drafted** (history). This is also
  the app's only render-time ESPN consumer, so every failure mode there degrades
  to a `Callout` — a public page must not 500 because ESPN is down or the
  cookies rotted.
- **`/draft-results` shows exactly one season and has no year picker.** Keeper
  prices depend only on the last draft, so older years are trivia. It resolves
  the latest *completed* draft (`getLatestDraftRecap`) and follows the new one
  automatically. A picker built from ESPN's `status.previousSeasons` was removed
  because that field lists only years *before* the one loaded, so choosing a
  year made later years disappear.
- **Bump `RECAP_SHAPE_VERSION` when `DraftRecap`'s shape changes.** It is part of
  the `unstable_cache` key. The data cache outlives deployments, so without a
  bump the new code reads objects written by the old code and renders undefined
  fields — see `.claude/lessons.md`.
- **The keeper round ladder lives in `src/lib/keepers.ts`,** not in the page.
  Three rounds better than where the player went, compounding each year he is
  kept; rounds 1–3 are ineligible (`null`, never floored to 1); undrafted costs
  a 12th. The rulebook text in `DEFAULT_RULES` states the same rule in prose —
  change both together.
- **`trade_assets` rows are immutable.** There is no edit path. Corrections are
  status transitions (`voided`/`rejected`/`cancelled`), each writing a
  `trade_events` row that stays visible forever. This is the whole point when
  somebody disputes a pick in August.
- **Derived state is rebuilt, never incrementally unapplied.** A full rebuild
  means the undo path cannot drift from the do path. It runs inside the same
  transaction as every status transition.
- **`draft_order` is delete-then-insert, not UPDATE.**
  `draft_order_season_current_team_uq` is a plain unique index, which Postgres
  enforces row-by-row within a statement, so resetting a swapped pair with one
  UPDATE would transiently collide.
- **Votes are keyed on team, not user.** Team BUES has two ESPN member GUIDs
  ("Rob Buesing" and "Robert Buesing"); keying on user would let one franchise
  cast two ballots and silently drift the denominator.
- **Pass math is integer cross-multiplication** (`yes * denom >= eligible *
  numer`), and `eligible_voter_count` is snapshotted when the ballot opens.
- **Authorization is always "does this user hold a seat for team X"**, never
  "is this user team X". That indirection makes co-managers free.
- **Every server action and route handler re-authorizes itself.** Server
  Functions are dispatched as POSTs to whatever route they're used on and are
  directly reachable, so `proxy.ts` does NOT protect them.
- **`team_managers.user_id` is nullable.** That is what lets the commissioner
  populate and backfill the entire ledger before anyone else signs up.
- **Picks exist only for the current and next season.** `FUTURE_SEASON_HORIZON`
  is 1 because the league forbids trading picks further out. That is the rulebook
  expressed in the schema: an untradeable pick is never created, so it cannot
  appear in the trade builder by accident. `pruneSeasonsBeyondHorizon` refuses to
  delete a season any trade asset references, since the cascade would orphan
  `trade_assets.draft_pick_id` and silently rewrite history.
- **`players.espn_player_id` is nullable.** The commissioner types a player's
  name when backfilling an old trade, long before any ESPN sync. Postgres treats
  NULLs as distinct, so any number of un-synced players coexist under the unique
  index; a later sync matches on name and fills in the id. Name matching is case-
  and whitespace-insensitive so one player does not become three.
- **Backfilled trades skip counterparty confirmation.** `createTrade({backfill})`
  is commissioner-only, requires the real `agreedOn` date, and lands `confirmed`.
  Two-step confirmation exists to stop one manager unilaterally asserting a
  trade; it is meaningless for one everybody played out months ago, and chasing
  eleven people for retroactive approval would mean history never gets entered.
  The audit trail records that it was backfilled.
- **`rules` is separate from `proposals`.** A proposal is a vote — a moment with
  a tally. A rule is the league's current law. Most rules predate this app and
  have no ballot; `rules.source_proposal_id` links the ones that do.
- **`users.email` is indexed but NOT unique.** Identity is `clerk_user_id`;
  email is metadata Clerk owns and can change, and two Clerk accounts can share
  an address. A unique index there turns that edge case into a 500 on sign-in.
  Lookups by email refuse to guess when they find duplicates.

## Version gotchas (verified, not remembered)

**Clerk 7 / Core 3** is a breaking rewrite of most snippets you'll find:
- `<SignedIn>`, `<SignedOut>`, `<Protect>` are **removed** → single `<Show when="signed-in">`.
- `createRouteMatcher` is **deprecated**; Clerk now discourages middleware auth gating.
- `ClerkProvider` goes **inside `<body>`**.
- `auth()`, `currentUser()`, `auth.protect()`, `clerkClient()` are all **async**.

**Next 16**:
- `middleware.ts` → **`src/proxy.ts`** (in `src/`, beside `app/`).
- `params` / `searchParams` / `cookies()` / `headers()` are **Promises**; the sync fallback is gone.
- `revalidateTag` now takes **two** arguments; `updateTag()` is the read-your-own-writes variant.
- `error.tsx` uses **`retry`**, not `reset`.
- Route handler `params` is a Promise.
- `PageProps<'/route'>` / `LayoutProps<'/'>` are generated globals — run
  `npx next typegen` before `tsc` on a cold checkout.

## Database driver

`src/db/index.ts` picks a driver from `DATABASE_URL`:
- Neon host → `drizzle-orm/neon-serverless` (WebSocket pool). **Not `neon-http`**,
  which cannot do interactive transactions, and every trade transition needs a
  real one.
- Anything else → `drizzle-orm/node-postgres`, so local Postgres works.

Connection is lazy so `next build` doesn't need a live database.

## Shipping a change

The default workflow, not something to ask about each time:

1. **Verify locally first** — tests, typecheck, and actually exercise the thing.
2. **Commit and push to `main`.** That is the deploy trigger; there is no
   separate release step.
3. **Wait for the Vercel deploy to finish**, then **open
   <https://narc-fantasy-football.vercel.app/> in the Chrome browser extension
   and confirm the change works in production.** The extension carries a real
   signed-in Clerk session, which is the only way to reach commissioner-gated UI
   — a local dev server cannot check those paths without someone signing in.
4. If production is broken, fix forward or revert; don't leave `main` red.

Two things that still need explicit sign-off, because they are not reversible by
a follow-up commit: **database migrations** (see below — migrate *before* the
deploy lands) and anything that **writes to the shared Neon database**, since
Production, Preview and Development all point at the same one.

## Deployment

Vercel project `narc-fantasy-football`, connected to the GitHub repo — **pushing
to `main` auto-deploys**. Postgres is Neon, provisioned through the Vercel
marketplace integration, one database shared by all three environments.

Env vars live in Vercel for Production and Development. **Preview is not set** —
PR previews will fail Clerk until someone adds them in the dashboard.

Schema changes go out in two steps, and the order matters:

```bash
npm run db:generate                       # commit the migration
DATABASE_URL="<neon pooled url>" npx drizzle-kit migrate
vercel --prod --yes
```

Migrate before deploying, or the new code meets the old schema.

Careful: `vercel integration add` **overwrites `.env.local`** and drops anything
it does not manage, including the Clerk keys. Back it up before running one.

Clerk runs on a **development** instance (`pk_test_`/`sk_test_`). That is normal
for a `*.vercel.app` domain, since a production instance needs DNS records on a
custom domain. Consequence: a dev banner and a 100-user cap, both irrelevant at
12 managers.

## Testing

`npm test` runs against **PGlite** — real Postgres compiled to WASM, so CHECK
constraints, unique indexes and transactions behave exactly as on Neon.
`src/db/constraints.test.ts` deliberately asserts that malformed rows are
rejected *by name*, since a foreign-key typo would otherwise look like a pass.

`npm run verify` runs the same flows against a real Postgres server, which is
where pooled-connection and transaction bugs actually live.

Nothing in `npm test` touches the network — `fetchLeague` is mocked. `npm run
espn:check` is the one thing that makes a real ESPN call: it hits the same
`fetchLeague` the sync uses, touches no database, and tells you whether the
cookies still authenticate. Run it first whenever a sync 401s, since expired
cookies and a genuine sync bug look identical from the UI.

`src/lib/auth/membership.test.ts` mocks Clerk's `auth()`/`currentUser()` to cover
the sign-in path. It is worth keeping honest: it found two crashes that only
appear with a real session — a duplicate-email collision on `users`, and a
co-manager whose two seats shared an invite email.

## Known gaps

- **2025-26 trade history is not imported.** No longer blocked on credentials —
  `espn_s2`/`SWID` are set in `.env.local` and in Vercel Production/Development,
  and `npm run espn:check -- --year 2025` confirms 2024 and 2025 both read back
  fine. What remains is the importer itself: read the
  `kona_league_communication` activity feed (msgId `244` = TRADED, carrying
  `from`/`to`/`targetId`) — **not** `mTransactions2`, whose `TRADE_ACCEPT` rows
  have no `items` array. Until it exists the commissioner enters past trades by
  hand with the backfill toggle.
- **Preview-environment env vars are unset** (see Deployment).
- **No favicon** from the Eph mark yet.
