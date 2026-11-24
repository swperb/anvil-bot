import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { GitHub, githubBody } from "../src/bounty/github.ts";
import type { Report } from "../src/bounty/store.ts";
import { loadConfig } from "../src/config.ts";

const report = (over: Partial<Report> = {}): Report => ({
  id: 7, reporterId: "259814169597968385", reporterTag: "someone#0001", title: "Fillet crashes", what: "It crashed.",
  steps: "1. Fillet", environment: "0.2.0 on Linux", credit: null, security: false, status: "accepted", severity: "high",
  threadId: null, messageId: null, createdAt: "2026-11-24T00:00:00Z", decidedAt: null, decidedBy: null, note: null, github: null,
  ...over,
});

test("the public body credits only the chosen name and never leaks Discord identities", () => {
  const anon = githubBody(report());
  assert.match(anon, /by an anonymous reporter \(bug bounty report #7, severity \*\*high\*\* \(50 bounty points\)\)/);
  assert.ok(!anon.includes("259814169597968385") && !anon.includes("someone#0001"));
  assert.match(githubBody(report({ credit: "Ada" })), /by \*\*Ada\*\*/);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(status: number, reply: object) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return calls;
}

test("an ordinary bug becomes a public issue labelled bug", async () => {
  const calls = mockFetch(201, { html_url: "https://github.com/o/r/issues/1" });
  const url = await new GitHub("tok", "o/r").fileIssue(report());
  assert.equal(url, "https://github.com/o/r/issues/1");
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues");
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.deepEqual([body.title, body.labels], ["Fillet crashes", ["bug"]]);
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("a security report becomes a draft advisory with its severity", async () => {
  const calls = mockFetch(201, { html_url: "https://github.com/o/r/security/advisories/GHSA-x" });
  await new GitHub("tok", "o/r").fileAdvisory(report({ security: true, severity: "critical" }));
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/security-advisories");
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.severity, "critical");
  assert.deepEqual(body.vulnerabilities, [{ package: { ecosystem: "other", name: "AnvilCAD" } }]);
});

test("GitHub errors carry the status and message", async () => {
  mockFetch(403, { message: "Resource not accessible by personal access token" });
  await assert.rejects(new GitHub("tok", "o/r").fileIssue(report()), /GitHub answered 403: Resource not accessible/);
});

test("the GitHub token is optional: a missing file means not set up", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-gh-"));
  const base = { DISCORD_TOKEN: "x.y.z" };
  assert.equal(loadConfig({ ...base, GITHUB_TOKEN_FILE: join(dir, "none") }).githubToken, null);
  writeFileSync(join(dir, "gh"), "github_pat_abc\n");
  const c = loadConfig({ ...base, GITHUB_TOKEN_FILE: join(dir, "gh") });
  assert.deepEqual([c.githubToken, c.githubRepo], ["github_pat_abc", "swperb/anvilcad"]);
  assert.throws(() => loadConfig({ ...base, GITHUB_REPO: "not a repo" }), /owner\/name/);
});
