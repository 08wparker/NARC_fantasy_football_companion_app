# Lessons

Patterns worth not repeating. Append after any correction.

## Version the cache key whenever a cached value's shape changes

**2026-08-12.** Added `keeperRound` to `DraftRecap` without touching the
`unstable_cache` key. The data cache still held objects written by the previous
build, so every row rendered `ordinal(undefined)` → `"?"`. TypeScript cannot
catch this: the cached value is deserialized as `any` at runtime.

This is worse in production than locally — **Vercel's data cache survives
deployments**, so a shape change ships broken for the full TTL (an hour here),
on a page that looked fine in review.

`src/lib/espn/draft.ts` now carries `RECAP_SHAPE_VERSION` inside the cache key.
Bump it in the same commit that changes the shape.

## Verify what a data source actually means before building UI on it

**2026-08-12.** Built a season switcher for `/draft-results` from ESPN's
`status.previousSeasons`. That field lists only seasons *before* the one
requested — so selecting 2024 dropped 2025 from the list and the buttons
appeared to vanish as you clicked them. The user caught it, not me.

I had verified the field *existed* and that the page rendered; I never clicked
through two years and compared. **Exercise the interaction, not just the first
paint.** The feature was then deleted outright — the league only ever cares
about the most recent draft, which is also worth asking before building a
navigation affordance nobody requested.

## Don't put secrets in the transcript when a side channel exists

**2026-08-12.** Retrieving ESPN cookies, the obvious path was to read them with
`document.cookie` and echo the values. Instead: inject a textarea, select it,
send a real `cmd+c` through the extension, and `pbpaste` straight into
`.env.local`. The credentials never entered the conversation. The Clipboard API
path (`navigator.clipboard.writeText`) fails with "Document is not focused" and
hangs the CDP call — real keystrokes work.

Tell the user afterwards that the value is sitting in their clipboard.
