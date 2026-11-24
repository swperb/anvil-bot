// The GitHub feed: posts what happens in the AnvilCAD repository to Discord, the
// way a development server's GitHub integration does.
//
//   #github    pull requests opened, merged, closed and reopened; issues opened,
//              closed and reopened; new comments; published releases.
//   #releases  every pull request merged into the default branch, and every
//              published release with its notes.
//
// Anvil polls the repository's public events instead of receiving a webhook,
// so no webhook secret has to be created, stored or handed to GitHub. GitHub
// asks clients to poll no more often than its X-Poll-Interval header (60s), and
// with an ETag an unchanged answer is a cheap 304.
//
// The events API's pull request events carry only the number, branches and
// commit IDs, not the title or author (checked against swperb/anvilcad in
// November 2026), so Anvil fetches each pull request it reports on. Issue, comment and release
// events still carry the whole object.
//
// API: https://docs.github.com/en/rest/activity/events#list-repository-events

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { log } from "./log.ts";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
/** How many event IDs to remember. The events API returns at most 300, newest first. */
const SEEN_LIMIT = 1000;

export type Target = "github" | "releases";

/** A plain Discord embed, so formatting can be tested without discord.js. */
export interface FeedEmbed {
  title: string;
  url: string;
  description?: string;
  color: number;
  author: string;
  footer?: string;
  timestamp: string;
}

export interface FeedPost {
  target: Target;
  embed: FeedEmbed;
}

export const COLOR = {
  opened: 0x2ea043,
  merged: 0x8957e5,
  closed: 0xcf222e,
  comment: 0x747f8d,
  release: 0x0969da,
} as const;

// The fields Anvil reads. GitHub sends more.
interface User { login: string; type?: string }
interface Label { name: string }
export interface Pull {
  number: number; title: string; html_url: string; body: string | null; user: User;
  draft?: boolean; merged?: boolean; merged_by?: User | null; base: { ref: string };
}
interface Issue { number: number; title: string; html_url: string; body: string | null; user: User; labels?: Label[]; pull_request?: object; state_reason?: string | null }
interface Comment { html_url: string; body: string | null; user: User }
interface Release { name: string | null; tag_name: string; html_url: string; body: string | null; draft?: boolean; prerelease?: boolean }
export interface GitHubEvent {
  id: string;
  type: string;
  actor: { login: string };
  created_at: string;
  payload: {
    action?: string;
    number?: number;
    issue?: Issue;
    comment?: Comment;
    release?: Release;
    pull_request?: { number: number };
  };
}

const isBot = (login: string) => login.endsWith("[bot]");

/** Cut text to `max` characters at a word boundary, adding an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The first paragraph of a pull request or issue body: what it is about, without
 * headings, check-lists, HTML comments or attribution lines.
 */
export function summary(body: string | null, max = 400): string {
  if (!body) return "";
  const text = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^(🤖\s*)?Generated with \[?Claude Code/.test(l) && !/^Co-Authored-By:/i.test(l));
    if (lines.length) return clip(lines.join(" "), max);
  }
  return "";
}

/** Labels as Discord inline code, e.g. "`bug` `good first issue`". */
function labels(issue: Issue): string | undefined {
  const names = (issue.labels ?? []).map((l) => `\`${l.name}\``);
  return names.length ? names.join(" ") : undefined;
}

/**
 * What to post for one event. `pull` is the fetched pull request for a
 * PullRequestEvent and is ignored otherwise.
 */
export function describe(event: GitHubEvent, repo: string, defaultBranch: string, pull?: Pull): FeedPost[] {
  const p = event.payload;
  const who = event.actor.login;
  const at = event.created_at;
  switch (event.type) {
    case "PullRequestEvent": {
      if (!pull) return [];
      const title = `#${pull.number} ${clip(pull.title, 200)}`;
      const base = { title, url: pull.html_url, author: who, timestamp: at };
      switch (p.action) {
        case "opened": {
          const kind = pull.draft ? "Draft pull request" : "Pull request";
          return [{ target: "github", embed: { ...base, color: COLOR.opened, description: summary(pull.body) || undefined, footer: `${kind} opened in ${repo}` } }];
        }
        case "reopened":
          return [{ target: "github", embed: { ...base, color: COLOR.opened, footer: `Pull request reopened in ${repo}` } }];
        case "merged":
        case "closed": {
          // Older events say "closed" for a merge too; the fetched pull request settles it.
          if (pull.merged || p.action === "merged") {
            const posts: FeedPost[] = [
              { target: "github", embed: { ...base, color: COLOR.merged, footer: `Pull request merged into ${pull.base.ref}` } },
            ];
            if (pull.base.ref === defaultBranch) {
              posts.push({
                target: "releases",
                embed: {
                  ...base,
                  author: pull.user.login,
                  color: COLOR.merged,
                  description: summary(pull.body) || undefined,
                  footer: `Merged into ${pull.base.ref}${pull.merged_by ? ` by ${pull.merged_by.login}` : ""}. In the next release.`,
                },
              });
            }
            return posts;
          }
          return [{ target: "github", embed: { ...base, color: COLOR.closed, footer: `Pull request closed without merging` } }];
        }
        default:
          return [];
      }
    }
    case "IssuesEvent": {
      const issue = p.issue;
      if (!issue || issue.pull_request) return [];
      const base = { title: `#${issue.number} ${clip(issue.title, 200)}`, url: issue.html_url, author: who, timestamp: at };
      switch (p.action) {
        case "opened": {
          const desc = [summary(issue.body), labels(issue)].filter(Boolean).join("\n\n");
          return [{ target: "github", embed: { ...base, color: COLOR.opened, description: desc || undefined, footer: `Issue opened in ${repo}` } }];
        }
        case "closed": {
          const why = issue.state_reason === "not_planned" ? "closed as not planned" : "closed as completed";
          return [{ target: "github", embed: { ...base, color: COLOR.closed, footer: `Issue ${why}` } }];
        }
        case "reopened":
          return [{ target: "github", embed: { ...base, color: COLOR.opened, footer: `Issue reopened` } }];
        default:
          return [];
      }
    }
    case "IssueCommentEvent": {
      const { issue, comment } = p;
      if (p.action !== "created" || !issue || !comment || isBot(comment.user.login)) return [];
      const on = issue.pull_request ? "pull request" : "issue";
      return [{
        target: "github",
        embed: {
          title: `#${issue.number} ${clip(issue.title, 200)}`,
          url: comment.html_url,
          author: comment.user.login,
          color: COLOR.comment,
          description: clip(comment.body ?? "", 300) || undefined,
          footer: `New comment on ${on}`,
          timestamp: at,
        },
      }];
    }
    case "ReleaseEvent": {
      const r = p.release;
      if (p.action !== "published" || !r || r.draft) return [];
      const name = r.name?.trim() || r.tag_name;
      const kind = r.prerelease ? "Pre-release" : "Release";
      const embed: FeedEmbed = {
        title: `${kind} ${name}`,
        url: r.html_url,
        author: who,
        color: COLOR.release,
        description: clip(r.body ?? "", 3500) || undefined,
        footer: `${repo} ${r.tag_name}`,
        timestamp: at,
      };
      return [{ target: "releases", embed }, { target: "github", embed: { ...embed, description: undefined } }];
    }
    default:
      return [];
  }
}

interface FeedState {
  /** False until the first successful poll, which records history without posting it. */
  primed: boolean;
  seen: string[];
}

function loadFeedState(path: string): FeedState {
  if (!existsSync(path)) return { primed: false, seen: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FeedState>;
  return { primed: raw.primed === true, seen: Array.isArray(raw.seen) ? raw.seen.filter((s) => typeof s === "string") : [] };
}

export class GitHubFeed {
  #token: string | null;
  #statePath: string;
  #state: FeedState;
  #etag: string | null = null;
  #defaultBranch: string | null = null;
  readonly repo: string;
  /** Seconds between polls; raised to whatever GitHub asks for. */
  interval: number;

  constructor(repo: string, token: string | null, statePath: string) {
    this.repo = repo;
    this.#token = token;
    this.#statePath = statePath;
    this.#state = loadFeedState(statePath);
    // Without a token GitHub allows 60 requests an hour, shared with nothing else here.
    this.interval = token ? 60 : 120;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "anvil-bot",
      ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
      ...extra,
    };
  }

  async #get<T>(path: string): Promise<T> {
    const response = await fetch(`${API}${path}`, { headers: this.#headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
    return (await response.json()) as T;
  }

  #save(): void {
    this.#state.seen = this.#state.seen.slice(-SEEN_LIMIT);
    writeFileSync(`${this.#statePath}.tmp`, JSON.stringify(this.#state) + "\n");
    renameSync(`${this.#statePath}.tmp`, this.#statePath);
  }

  /**
   * Fetch new events and return what to post, oldest first. Returns nothing on
   * the very first poll, so a fresh start does not replay the last 90 days.
   * Call `markPosted` with each event's ID once its posts are sent.
   */
  async poll(): Promise<{ id: string; posts: FeedPost[] }[]> {
    const response = await fetch(`${API}/repos/${this.repo}/events?per_page=100`, {
      headers: this.#headers(this.#etag ? { "If-None-Match": this.#etag } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const asked = Number(response.headers.get("x-poll-interval"));
    if (asked > 0) this.interval = Math.max(asked, this.#token ? 60 : 120);
    if (response.status === 304) return [];
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the event list`);
    const etag = response.headers.get("etag");
    const events = (await response.json()) as GitHubEvent[];

    const seen = new Set(this.#state.seen);
    // The list is newest first, but not strictly by time; order by ID, which GitHub assigns in sequence.
    const fresh = events.filter((e) => !seen.has(e.id)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (!this.#state.primed) {
      this.#state = { primed: true, seen: [...this.#state.seen, ...fresh.map((e) => e.id)] };
      this.#save();
      this.#etag = etag;
      log.info(`GitHub feed: watching ${this.repo}; ${fresh.length} earlier events were not posted.`);
      return [];
    }

    this.#defaultBranch ??= (await this.#get<{ default_branch: string }>(`/repos/${this.repo}`)).default_branch;
    const out: { id: string; posts: FeedPost[] }[] = [];
    for (const event of fresh) {
      let pull: Pull | undefined;
      const number = event.payload.number ?? event.payload.pull_request?.number;
      if (event.type === "PullRequestEvent" && number) pull = await this.#get<Pull>(`/repos/${this.repo}/pulls/${number}`);
      out.push({ id: event.id, posts: describe(event, this.repo, this.#defaultBranch, pull) });
    }
    // Only now: if a fetch above failed, the next poll must see this list again, not a 304.
    this.#etag = etag;
    return out;
  }

  markPosted(id: string): void {
    this.#state.seen.push(id);
    this.#save();
  }
}
