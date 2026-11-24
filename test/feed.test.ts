import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { clip, COLOR, describe, GitHubFeed, summary, type GitHubEvent, type Pull } from "../src/feed.ts";

const REPO = "swperb/anvilcad";
const ev = (over: Partial<GitHubEvent>): GitHubEvent => ({
  id: "100", type: "WatchEvent", actor: { login: "swperb" }, created_at: "2026-11-24T17:45:21Z", payload: {}, ...over,
});
const pull = (over: Partial<Pull> = {}): Pull => ({
  number: 161, title: "Add a live Discord badge", html_url: "https://github.com/swperb/anvilcad/pull/161",
  body: "Adds the badge.\n\n## Testing\n- ran it\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  user: { login: "author" }, merged: true, merged_by: { login: "swperb" }, base: { ref: "main" }, ...over,
});

test("summary keeps the first real paragraph and drops headings, comments and attribution", () => {
  assert.equal(summary("## Summary\nFixes the solver.\nAnd more.\n\n## Test plan\n- x"), "Fixes the solver. And more.");
  assert.equal(summary("<!-- template -->\n\n🤖 Generated with [Claude Code](https://x)"), "");
  assert.equal(summary(null), "");
});

test("clip cuts at a word and marks the cut", () => {
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("alpha beta gamma delta", 15), "alpha beta…");
  assert.equal(clip("abcdefghijklmnop", 8), "abcdefg…");
});

test("a merged pull request goes to #github and, on the default branch, to #releases", () => {
  const posts = describe(ev({ type: "PullRequestEvent", payload: { action: "merged", number: 161 } }), REPO, "main", pull());
  assert.deepEqual(posts.map((p) => p.target), ["github", "releases"]);
  const rel = posts[1]!.embed;
  assert.equal(rel.title, "#161 Add a live Discord badge");
  assert.equal(rel.author, "author");
  assert.equal(rel.description, "Adds the badge.");
  assert.equal(rel.color, COLOR.merged);
  assert.equal(rel.footer, "Merged into main by swperb. In the next release.");
});

test("a merge into another branch and a closed pull request stay out of #releases", () => {
  const other = describe(ev({ type: "PullRequestEvent", payload: { action: "merged", number: 1 } }), REPO, "main", pull({ base: { ref: "dev" } }));
  assert.deepEqual(other.map((p) => p.target), ["github"]);
  const closed = describe(ev({ type: "PullRequestEvent", payload: { action: "closed", number: 1 } }), REPO, "main", pull({ merged: false }));
  assert.deepEqual(closed.map((p) => [p.target, p.embed.color, p.embed.footer]), [["github", COLOR.closed, "Pull request closed without merging"]]);
});

test("an opened draft says so; other pull request actions post nothing", () => {
  const [opened] = describe(ev({ type: "PullRequestEvent", payload: { action: "opened", number: 1 } }), REPO, "main", pull({ draft: true, merged: false }));
  assert.equal(opened!.embed.footer, `Draft pull request opened in ${REPO}`);
  assert.deepEqual(describe(ev({ type: "PullRequestEvent", payload: { action: "labeled", number: 1 } }), REPO, "main", pull()), []);
});

const issue = { number: 150, title: "Solver says over defined", html_url: "https://github.com/swperb/anvilcad/issues/150", body: "It is wrong.", user: { login: "swperb" }, labels: [{ name: "bug" }, { name: "good first issue" }] };

test("issues: opened shows summary and labels, closed says why", () => {
  const [opened] = describe(ev({ type: "IssuesEvent", payload: { action: "opened", issue } }), REPO, "main");
  assert.equal(opened!.embed.description, "It is wrong.\n\n`bug` `good first issue`");
  const [closed] = describe(ev({ type: "IssuesEvent", payload: { action: "closed", issue: { ...issue, state_reason: "not_planned" } } }), REPO, "main");
  assert.equal(closed!.embed.footer, "Issue closed as not planned");
});

test("comments from bots are skipped; comments on pull requests say so", () => {
  const comment = { html_url: "https://github.com/x#c", body: "Looks good", user: { login: "ada" } };
  const [c] = describe(ev({ type: "IssueCommentEvent", payload: { action: "created", issue: { ...issue, pull_request: {} }, comment } }), REPO, "main");
  assert.equal(c!.embed.footer, "New comment on pull request");
  assert.equal(c!.embed.author, "ada");
  const bot = { ...comment, user: { login: "github-actions[bot]" } };
  assert.deepEqual(describe(ev({ type: "IssueCommentEvent", payload: { action: "created", issue, comment: bot } }), REPO, "main"), []);
});

test("a published release goes to #releases with its notes and to #github without them", () => {
  const release = { name: "AnvilCAD 0.2.0", tag_name: "v0.2.0", html_url: "https://github.com/swperb/anvilcad/releases/tag/v0.2.0", body: "Notes" };
  const posts = describe(ev({ type: "ReleaseEvent", payload: { action: "published", release } }), REPO, "main");
  assert.deepEqual(posts.map((p) => [p.target, p.embed.title, p.embed.description]), [
    ["releases", "Release AnvilCAD 0.2.0", "Notes"],
    ["github", "Release AnvilCAD 0.2.0", undefined],
  ]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the first poll records history without posting; later polls post new events oldest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-"));
  let events: GitHubEvent[] = [ev({ id: "5" }), ev({ id: "4" })];
  const urls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(url);
    const h = new Headers(init.headers);
    if (url.endsWith("/events?per_page=100")) {
      if (h.get("If-None-Match") === '"same"' && events.length === 2) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(events), { status: 200, headers: { etag: '"same"', "x-poll-interval": "90" } });
    }
    if (url.endsWith(`/repos/${REPO}`)) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (url.endsWith("/pulls/161")) return new Response(JSON.stringify(pull()), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const feed = new GitHubFeed(REPO, "tok", join(dir, "feed.json"));
  assert.deepEqual(await feed.poll(), []);
  assert.equal(feed.interval, 90);
  assert.deepEqual(await feed.poll(), [], "an unchanged list is a 304 and posts nothing");

  events = [ev({ id: "7", type: "PullRequestEvent", payload: { action: "merged", number: 161 } }), ev({ id: "6" }), ...events];
  const out = await feed.poll();
  assert.deepEqual(out.map((o) => [o.id, o.posts.length]), [["6", 0], ["7", 2]]);
  for (const o of out) feed.markPosted(o.id);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "feed.json"), "utf8")).seen, ["4", "5", "6", "7"]);

  // A restart remembers what was posted.
  const again = new GitHubFeed(REPO, "tok", join(dir, "feed.json"));
  globalThis.fetch = (async () => new Response(JSON.stringify(events), { status: 200 })) as typeof fetch;
  assert.deepEqual(await again.poll(), []);
});
