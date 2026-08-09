<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# NARC Fantasy Football Companion

Companion app for a 12-team ESPN keeper league (leagueId `718396`). Two jobs:

1. **Remember draft-asset trades across seasons** — future round picks, draft
   slot swaps, keeper rights/slots, and player-for-pick.
2. **Run rule-change votes.**

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
npm test             # vitest — 91 tests, all against real Postgres (PGlite/WASM)
npm run typecheck    # run `npx next typegen` first on a cold checkout
npm run verify       # end-to-end checks against a REAL Postgres server
npm run db:generate  # generate a migration from src/db/schema.ts
npm run db:migrate   # apply migrations
npm run db:seed      # idempotent: league, 12 teams, 4 seasons of picks
npm run db:studio    # drizzle studio
```

## Architecture

Three layers, deliberately separate. The invariant: **drop every derived column,
recompute from the ledger, and you get an identical database.**

| Layer | Source of truth | Mutability |
|---|---|---|
| ESPN mirror — `teams`, `team_seasons`, `espn_members`, `players`, `roster_spots`, `sync_runs` | ESPN | upsert-only, never deleted, never hand-edited |
| Ledger — `trades`, `trade_assets`, `trade_events`, `proposals`, `votes` | this app | append-only + status transitions |
| Derived — `draft_picks.current_owner_team_id`, `draft_order.current_team_id` | computed | rebuildable from scratch |

### Key files

- `src/db/schema.ts` — the whole model, with integrity pushed into Postgres
- `src/db/derive.ts` — `rebuildDerivedState`, the correctness core
- `src/db/trade-service.ts` — the trade state machine
- `src/db/proposal-service.ts` — voting and tallying
- `src/db/queries.ts` — draft board (snake math), provenance, history
- `src/lib/espn/{client,sync}.ts` — the mirror
- `src/lib/auth/membership.ts` — the single authorization entry point
- `src/proxy.ts` — Clerk middleware (Next 16 renamed `middleware.ts`)

### Rules that are load-bearing

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
  which cannot do interactive transactions.
- Anything else → `drizzle-orm/node-postgres`, so local Postgres works.

Connection is lazy so `next build` doesn't need a live database.

## Testing

`npm test` runs against **PGlite** — real Postgres compiled to WASM, so CHECK
constraints, unique indexes and transactions behave exactly as on Neon.
`src/db/constraints.test.ts` deliberately asserts that malformed rows are
rejected *by name*, since a foreign-key typo would otherwise look like a pass.

`npm run verify` runs the same flows against a real Postgres server, which is
where pooled-connection and transaction bugs actually live.
