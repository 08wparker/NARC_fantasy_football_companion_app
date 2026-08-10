# NARC Fantasy Football Companion

A companion app for a 12-team ESPN keeper league. It remembers the things ESPN
forgets, and runs the league's rule votes.

## Why it exists

ESPN's fantasy API **has no representation for a traded draft pick**. Every
transaction item is keyed on a player id, and ESPN's own UI only supports
trading current-season picks — never future years. So a keeper league that
trades 2027 picks has nowhere to record it except a group chat.

This app is that record:

- **Draft-asset ledger** — future round picks, draft slot swaps, keeper rights
  and keeper slots. Either party logs a trade; it does not move anything until
  the counterparty confirms. Trades are never edited, only voided, so the
  history survives an argument in August.
- **Draft board** — every future season in pick order, showing who owns what and
  where it came from.
- **Rule votes** — anyone proposes, the commissioner opens the ballot, one vote
  per franchise, with an explicit pass threshold.

ESPN is synced in as a read-only mirror for team names and rosters. It is never
the source of truth for anything draft-related.

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
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | A [Clerk](https://clerk.com) application. Turn on **Restricted mode** under Configure → Restrictions, then invite the 11 other managers — invitations alone do not restrict sign-ups. |
| `ESPN_S2`, `ESPN_SWID` | Only needed for ESPN sync. The league is private, so requests 401 without them. Copy from a logged-in browser: DevTools → Application → Cookies → `espn.com`. `SWID` includes its curly braces. |

The ledger has **no ESPN dependency** — everything except roster sync works
before you ever paste a cookie.

## Adding the other managers

Someone claims their franchise by signing in with an email that matches the
`invite_email` on their seat. Set those on the commissioner page, or:

```bash
npm run db:link -- --email tyler@example.com --team HULL
```

The CLI works with no session, which matters because the commissioner page
requires you to already be a commissioner — circular before anyone has claimed
a seat.

## Development

```bash
npm test          # 119 tests against real Postgres (PGlite/WASM)
npm run verify    # end-to-end checks against a real Postgres server
npm run build
```

See [AGENTS.md](AGENTS.md) for architecture and the design decisions worth
knowing before changing anything.
