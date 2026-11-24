import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rulesText } from "../src/bounty/rules.ts";
import { BountyStore, rankFor } from "../src/bounty/store.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "anvil-bounty-")), "bounty.json");
const report = (reporterId: string, title = "crash") => ({
  reporterId, reporterTag: reporterId, title, what: "it crashed", steps: "1. open", environment: "0.2.0 macOS", credit: null, security: false,
});

test("points come only from accepted reports, by severity", () => {
  const s = new BountyStore(fresh());
  const a = s.create(report("u1"));
  const b = s.create(report("u1"));
  const c = s.create(report("u1"));
  s.update(a.id, { status: "accepted", severity: "high" });
  s.update(b.id, { status: "accepted", severity: "low" });
  s.update(c.id, { status: "duplicate", note: "report #1" });
  assert.deepEqual(s.pointsOf("u1"), { points: 60, accepted: 2 });
  s.update(a.id, { status: "open", severity: null });
  assert.deepEqual(s.pointsOf("u1"), { points: 10, accepted: 1 });
});

test("ranks: only the highest reached", () => {
  assert.equal(rankFor(0), null);
  assert.equal(rankFor(9), null);
  assert.equal(rankFor(10), "hunter");
  assert.equal(rankFor(100), "senior");
  assert.equal(rankFor(249), "senior");
  assert.equal(rankFor(250), "master");
});

test("leaderboard orders by points, then by who got there first", () => {
  const s = new BountyStore(fresh());
  const x = s.create(report("early"));
  const y = s.create(report("late"));
  const z = s.create(report("top"));
  s.update(x.id, { status: "accepted", severity: "medium", decidedAt: "2026-01-01T00:00:00Z" });
  s.update(y.id, { status: "accepted", severity: "medium", decidedAt: "2026-02-01T00:00:00Z" });
  s.update(z.id, { status: "accepted", severity: "critical", decidedAt: "2026-03-01T00:00:00Z" });
  assert.deepEqual(s.leaderboard(10).map((e) => e.userId), ["top", "early", "late"]);
  assert.equal(s.leaderboard(1).length, 1);
});

test("survives a restart and keeps numbering", () => {
  const path = fresh();
  const s = new BountyStore(path);
  s.setChannel("123456789012345678");
  s.setRole("hunter", "223456789012345678");
  s.create(report("u1"));
  const again = new BountyStore(path);
  assert.equal(again.channelId, "123456789012345678");
  assert.equal(again.roleId("hunter"), "223456789012345678");
  assert.equal(again.create(report("u2")).id, 2);
});

test("counts reports in the last day for the daily limit", () => {
  const s = new BountyStore(fresh());
  s.create(report("u1"));
  const old = s.create(report("u1"));
  s.update(old.id, { createdAt: "2020-01-01T00:00:00Z" });
  assert.equal(s.countSince("u1", new Date(Date.now() - 86_400_000)), 1);
});

test("the rules fit in one Discord message", () => {
  assert.ok(rulesText().length <= 2000, `rules are ${rulesText().length} characters`);
});
