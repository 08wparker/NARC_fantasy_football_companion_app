# NARC Fantasy Football Companion

The North Adams Rowing Club keeper league, in an app. It remembers the things
ESPN forgets, and runs the league's rulebook.

**<https://narc-fantasy-football.vercel.app>**

## Why it exists

ESPN's fantasy API **has no representation for a traded draft pick**. Every
transaction item is keyed on a player id, and ESPN's own UI only supports
trading current-season picks — never future years. So a keeper league that
trades next year's 3rd has nowhere to record it except a group chat.

This app is that record:

- **Trade ledger** — draft picks, players, and draft slot swaps. Either party
  logs a trade; nothing moves until the counterparty confirms. Trades are never
  edited, only voided, and the reason stays on the record — so the history
  survives an argument in August.
- **Draft board** — the current and next season in pick order, showing who owns
  each pick and which team it came from.
- **Rulebook** — the league's standing rules, editable by the commissioner.
- **Rule votes** — anyone proposes, the commissioner opens the ballot, one vote
  per franchise, with an explicit pass threshold.

ESPN is synced in as a read-only mirror for team names and rosters. It is never
the source of truth for anything draft-related.

## Rules the app enforces

Not just documents — these are rejected in code:

- Picks are tradeable only for the **current and next season**.
- **Keeper rights** cannot be traded apart from the player; the right follows
  them.
- **Keeper slots** cannot be traded at all.
- One vote per franchise. A rule change needs two-thirds of **all 12** teams, so
  abstaining and not voting have the same effect as a no.

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run db:migrate
npm run db:seed
npm run db:link -- --list      # see who holds which manager seat
npm run dev
```

You need:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | A [Neon](https://neon.tech) Postgres project (use the **pooled** connection string), or any local Postgres. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | A [Clerk](https://clerk.com) application. Sign yourself up **first**, then turn on **Restricted mode** under Configure → Restrictions — invitations alone do not restrict sign-ups, and enabling it before you have an account locks you out of your own app. |
| `ESPN_S2`, `ESPN_SWID` | Only needed for ESPN sync. The league is private, so requests 401 without them. Copy from a logged-in browser: DevTools → Application → Cookies → `espn.com`. `SWID` includes its curly braces. |

The ledger has **no ESPN dependency** — everything except roster sync works
before you ever paste a cookie.

## Adding the other managers

Someone claims their franchise by signing in with an email matching the
`invite_email` on their seat. Set those on the commissioner page, or:

```bash
npm run db:link -- --email tyler@example.com --team HULL
```

The CLI works with no session, which matters because the commissioner page
requires you to already be a commissioner — circular before anyone has claimed
a seat.

## Recording past trades

The commissioner can enter a trade that already happened: tick **Already
agreed** on the trade form and give the date. It lands confirmed without
chasing the counterparty, and the audit trail notes it was backfilled.

Players can be typed by name — no ESPN sync required — so last season's trades
can go in before any cookie exists.

## Deployment

Vercel, connected to this repo: **pushing to `main` deploys**. Run migrations
against Neon *before* deploying, so the new code never meets the old schema.

```bash
npm run db:generate
DATABASE_URL="<neon pooled url>" npx drizzle-kit migrate
git push          # or: vercel --prod --yes
```

## Development

```bash
npm test          # 146 tests against real Postgres (PGlite/WASM)
npm run verify    # end-to-end checks against a real Postgres server
npm run espn:check  # confirm the ESPN cookies still authenticate
npm run build
```

See [AGENTS.md](AGENTS.md) for the architecture and the design decisions worth
knowing before changing anything.
