/**
 * End-to-end verification against a REAL Postgres server.
 *
 * The unit tests run on PGlite, which is single-connection and in-process. This
 * exercises the same code through the production driver path — pooled
 * connections and real BEGIN/COMMIT — which is where transaction bugs actually
 * live.
 *
 *   npm run verify
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { rebuildDerivedState } from "@/db/derive";
import { castVote, closeVoting, createProposal, getTally, openVoting } from "@/db/proposal-service";
import { draftBoard, pickProvenance } from "@/db/queries";
import * as schema from "@/db/schema";
import { confirmTrade, createTrade, voidTrade } from "@/db/trade-service";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok ? "" : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

async function main() {
  const league = await db.query.leagues.findFirst({
    where: eq(schema.leagues.espnLeagueId, process.env.ESPN_LEAGUE_ID ?? "718396"),
  });
  if (!league) throw new Error("Seed the database first: npm run db:seed");

  const teams = await db.query.teams.findMany({ where: eq(schema.teams.leagueId, league.id) });
  const T = Object.fromEntries(teams.map((t) => [t.abbrev, t]));

  const season = await db.query.seasons.findFirst({
    where: and(eq(schema.seasons.leagueId, league.id), eq(schema.seasons.year, 2027)),
  });
  if (!season) throw new Error("2027 season missing");

  // A scratch user to act as. Real users arrive via Clerk.
  const [user] = await db
    .insert(schema.users)
    .values({ clerkUserId: "verify_script", email: "verify@narc.test", displayName: "Verify" })
    .onConflictDoUpdate({ target: schema.users.clerkUserId, set: { displayName: "Verify" } })
    .returning();

  const wfp = { userId: user.id, teamIds: [T.WFP.id], isCommissioner: false };
  const sack = { userId: user.id, teamIds: [T.SACK.id], isCommissioner: false };
  const commish = { userId: user.id, teamIds: [T.SACK.id], isCommissioner: true };

  const pickOf = async (abbrev: string, round: number) =>
    (await db.query.draftPicks.findFirst({
      where: and(
        eq(schema.draftPicks.seasonId, season.id),
        eq(schema.draftPicks.round, round),
        eq(schema.draftPicks.originalTeamId, T[abbrev].id),
      ),
    }))!;

  const ownerAbbrev = async (pickId: number) => {
    const p = await db.query.draftPicks.findFirst({
      where: eq(schema.draftPicks.id, pickId),
      with: { currentOwner: true },
    });
    return p!.currentOwner.abbrev;
  };

  const boardAbbrevs = async () =>
    (await draftBoard(db, season.id))
      .filter((p) => p.round === 1)
      .slice(0, 4)
      .map((p) => p.originalTeam.abbrev);

  console.log("\n▸ Baseline");
  const wfp3 = await pickOf("WFP", 3);
  check("WFP owns its own 2027 3rd", await ownerAbbrev(wfp3.id), "WFP");
  check("round-1 board order starts SACK,BUES,WFP,NOVA", await boardAbbrevs(), [
    "SACK",
    "BUES",
    "WFP",
    "NOVA",
  ]);

  console.log("\n▸ Log a pick trade (pending)");
  const { trade } = await createTrade(db, wfp, {
    leagueId: league.id,
    loggedByTeamId: T.WFP.id,
    assets: [
      {
        kind: "draft_pick",
        fromTeamId: T.WFP.id,
        toTeamId: T.SACK.id,
        draftPickId: wfp3.id,
      },
    ],
    note: "verification run",
  });
  check("pending trade moves nothing", await ownerAbbrev(wfp3.id), "WFP");

  console.log("\n▸ Proposer cannot confirm their own trade");
  let selfConfirmBlocked = false;
  try {
    await confirmTrade(db, wfp, trade.id);
  } catch {
    selfConfirmBlocked = true;
  }
  check("self-confirm rejected", selfConfirmBlocked, true);

  console.log("\n▸ Counterparty confirms");
  await confirmTrade(db, sack, trade.id);
  check("pick now owned by SACK", await ownerAbbrev(wfp3.id), "SACK");
  check("provenance shows one hop", (await pickProvenance(db, wfp3.id)).map((h) => `${h.from}->${h.to}`), [
    "WFP->SACK",
  ]);

  console.log("\n▸ Chain it onward to NOVA");
  const { trade: t2 } = await createTrade(db, sack, {
    leagueId: league.id,
    loggedByTeamId: T.SACK.id,
    assets: [
      { kind: "draft_pick", fromTeamId: T.SACK.id, toTeamId: T.NOVA.id, draftPickId: wfp3.id },
    ],
  });
  await confirmTrade(db, { userId: user.id, teamIds: [T.NOVA.id], isCommissioner: false }, t2.id);
  check("chain lands on NOVA", await ownerAbbrev(wfp3.id), "NOVA");
  check(
    "provenance shows both hops",
    (await pickProvenance(db, wfp3.id)).map((h) => `${h.from}->${h.to}`),
    ["WFP->SACK", "SACK->NOVA"],
  );

  console.log("\n▸ Slot swap moves a whole set of picks");
  const { trade: t3 } = await createTrade(db, wfp, {
    leagueId: league.id,
    loggedByTeamId: T.WFP.id,
    assets: [
      {
        kind: "draft_slot_swap",
        fromTeamId: T.WFP.id,
        toTeamId: T.SACK.id,
        seasonId: season.id,
      },
    ],
  });
  await confirmTrade(db, sack, t3.id);
  check("WFP and SACK swapped board slots", await boardAbbrevs(), [
    "WFP",
    "BUES",
    "SACK",
    "NOVA",
  ]);

  console.log("\n▸ Commissioner voids the swap");
  await voidTrade(db, commish, t3.id, "verification cleanup");
  check("board order restored", await boardAbbrevs(), ["SACK", "BUES", "WFP", "NOVA"]);

  console.log("\n▸ Void the middle of the chain");
  await voidTrade(db, commish, t2.id, "verification cleanup");
  check("pick falls back to SACK", await ownerAbbrev(wfp3.id), "SACK");
  await voidTrade(db, commish, trade.id, "verification cleanup");
  check("pick returns to WFP", await ownerAbbrev(wfp3.id), "WFP");
  check("provenance is empty again", await pickProvenance(db, wfp3.id), []);

  console.log("\n▸ Assets survive the void (nothing is deleted)");
  const survivingAssets = await db.query.tradeAssets.findMany({
    where: eq(schema.tradeAssets.tradeId, trade.id),
  });
  check("original asset row still present", survivingAssets.length, 1);
  const events = await db.query.tradeEvents.findMany({
    where: eq(schema.tradeEvents.tradeId, trade.id),
    orderBy: (e, { asc }) => [asc(e.id)],
  });
  check("audit trail is created→confirmed→voided", events.map((e) => e.action), [
    "created",
    "confirmed",
    "voided",
  ]);

  console.log("\n▸ Rebuild is idempotent");
  const before = (await draftBoard(db, season.id)).map((p) => p.currentOwner.abbrev);
  await rebuildDerivedState(db, season.id);
  const after = (await draftBoard(db, season.id)).map((p) => p.currentOwner.abbrev);
  check("board unchanged by a fresh rebuild", after, before);

  console.log("\n▸ Rule vote: 8 of 12 passes");
  const proposal = await createProposal(db, wfp, {
    leagueId: league.id,
    title: `Verification proposal ${Date.now()}`,
    body: "Created by the verification script.",
  });
  await openVoting(db, commish, proposal.id, {
    closesAt: new Date(Date.now() + 86_400_000),
  });
  const tallyOpen = await getTally(db, proposal.id);
  check("needs 8 of 12", [tallyOpen.requiredYes, tallyOpen.eligible], [8, 12]);

  const voters = ["SACK", "BUES", "WFP", "NOVA", "DICK", "MAYE", "BYRN"];
  for (const abbrev of voters) {
    await castVote(
      db,
      { userId: user.id, teamIds: [T[abbrev].id], isCommissioner: false },
      { proposalId: proposal.id, teamId: T[abbrev].id, choice: "yes" },
    );
  }
  check("7 yes does not pass", (await getTally(db, proposal.id)).passed, false);

  await castVote(
    db,
    { userId: user.id, teamIds: [T.HULL.id], isCommissioner: false },
    { proposalId: proposal.id, teamId: T.HULL.id, choice: "yes" },
  );
  check("8 yes passes", (await getTally(db, proposal.id)).passed, true);

  console.log("\n▸ One ballot per franchise");
  await castVote(
    db,
    { userId: user.id, teamIds: [T.HULL.id], isCommissioner: false },
    { proposalId: proposal.id, teamId: T.HULL.id, choice: "no" },
  );
  const afterChange = await getTally(db, proposal.id);
  check("changing a vote does not add a ballot", afterChange.cast, 8);
  check("it flips the count instead", [afterChange.yes, afterChange.no], [7, 1]);

  const { proposal: closed } = await closeVoting(db, commish, proposal.id);
  check("closes as failed at 7 yes", closed.status, "failed");

  console.log(
    failures === 0
      ? "\n✅ All verification checks passed against real Postgres.\n"
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
