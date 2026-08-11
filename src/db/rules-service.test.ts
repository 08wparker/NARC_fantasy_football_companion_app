import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RULES,
  addRule,
  deleteRule,
  listRules,
  moveRule,
  seedDefaultRules,
  updateRule,
} from "@/db/rules-service";
import * as schema from "@/db/schema";
import { seedLeague } from "@/db/seed";
import type { Db } from "@/db/types";
import { makeTestDb } from "@/test/db";

describe("league rules", () => {
  let db: Db;
  let leagueId: number;

  beforeEach(async () => {
    ({ db } = await makeTestDb());
    const { league } = await seedLeague(db, { espnLeagueId: "718396", currentYear: 2026 });
    leagueId = league.id;
  });

  it("seeds the agreed rulebook", async () => {
    const rules = await listRules(db, leagueId);
    expect(rules).toHaveLength(DEFAULT_RULES.length);
    expect(rules.map((r) => r.body)).toEqual([...DEFAULT_RULES]);
  });

  it("records the rules we actually agreed", async () => {
    const bodies = (await listRules(db, leagueId)).map((r) => r.body).join(" ");
    expect(bodies).toMatch(/keeps 3 players/i);
    expect(bodies).toMatch(/16 rounds/i);
    expect(bodies).toMatch(/current and next season/i);
    expect(bodies).toMatch(/keeper rights cannot be traded separately/i);
    expect(bodies).toMatch(/two-thirds/i);
  });

  it("does not duplicate the rulebook on re-seed", async () => {
    await seedDefaultRules(db, leagueId);
    await seedDefaultRules(db, leagueId);
    expect(await listRules(db, leagueId)).toHaveLength(DEFAULT_RULES.length);
  });

  it("appends new rules to the end", async () => {
    const rule = await addRule(db, leagueId, "Waivers run Wednesday at 3am.");
    const rules = await listRules(db, leagueId);
    expect(rules.at(-1)!.id).toBe(rule.id);
  });

  it("rejects a blank rule", async () => {
    await expect(addRule(db, leagueId, "   ")).rejects.toThrow(/needs some text/i);
  });

  it("edits and deletes", async () => {
    const rule = await addRule(db, leagueId, "Original text.");
    await updateRule(db, leagueId, rule.id, "  Revised text.  ");

    const after = await db.query.rules.findFirst({ where: eq(schema.rules.id, rule.id) });
    expect(after!.body).toBe("Revised text.");

    await deleteRule(db, leagueId, rule.id);
    expect(await db.query.rules.findFirst({ where: eq(schema.rules.id, rule.id) })).toBeUndefined();
  });

  it("reorders without collapsing the list", async () => {
    const before = await listRules(db, leagueId);
    const second = before[1];

    await moveRule(db, leagueId, second.id, "up");
    const after = await listRules(db, leagueId);

    expect(after).toHaveLength(before.length);
    expect(after[0].id).toBe(second.id);
    expect(after[1].id).toBe(before[0].id);
    // everything below the swap keeps its order
    expect(after.slice(2).map((r) => r.id)).toEqual(before.slice(2).map((r) => r.id));
  });

  it("is a no-op at the ends of the list", async () => {
    const rules = await listRules(db, leagueId);
    await moveRule(db, leagueId, rules[0].id, "up");
    await moveRule(db, leagueId, rules.at(-1)!.id, "down");
    expect((await listRules(db, leagueId)).map((r) => r.id)).toEqual(rules.map((r) => r.id));
  });

  it("refuses a rule from another league", async () => {
    const rule = await addRule(db, leagueId, "Ours.");
    await expect(updateRule(db, 9999, rule.id, "theirs")).rejects.toThrow(/does not exist/i);
    await expect(deleteRule(db, 9999, rule.id)).rejects.toThrow(/does not exist/i);
  });
});
