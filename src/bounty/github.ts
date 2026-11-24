// Filing confirmed bug reports on GitHub: a public issue for an ordinary bug, a
// draft (private) security advisory for a security report.
//
// Needs a fine-grained personal access token limited to the one repository,
// with Issues and Repository security advisories set to read and write. Without
// a token, reports are confirmed in Discord only and admins file them by hand.
//
// API: https://docs.github.com/en/rest/issues/issues#create-an-issue and
// https://docs.github.com/en/rest/security-advisories/repository-advisories#create-a-repository-security-advisory

import { POINTS, type Report } from "./store.ts";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

/** The public text of an issue or advisory. Never includes Discord IDs or names unless the reporter gave a credit name. */
export function githubBody(report: Report): string {
  const who = report.credit ? `**${report.credit}**` : "an anonymous reporter";
  const severity = report.severity ? `, severity **${report.severity}** (${POINTS[report.severity]} bounty points)` : "";
  return [
    `Reported on the AnvilCAD Discord by ${who} (bug bounty report #${report.id}${severity}).`,
    "",
    "### What went wrong",
    report.what,
    "",
    "### Steps to reproduce",
    report.steps,
    "",
    "### Version and system",
    report.environment,
    "",
    "---",
    "Filed by Anvil, the Discord bot, after an admin confirmed the report.",
  ].join("\n");
}

export class GitHub {
  #token: string;
  readonly repo: string;

  constructor(token: string, repo: string) {
    this.#token = token;
    this.repo = repo;
  }

  async #post(path: string, body: unknown): Promise<{ html_url: string }> {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "anvil-bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => ({}))) as { html_url?: string; message?: string };
    if (!response.ok || !data.html_url) {
      throw new Error(`GitHub answered ${response.status}${data.message ? `: ${data.message}` : ""}`);
    }
    return { html_url: data.html_url };
  }

  async fileIssue(report: Report): Promise<string> {
    const { html_url } = await this.#post(`/repos/${this.repo}/issues`, {
      title: report.title,
      body: githubBody(report),
      labels: ["bug"],
    });
    return html_url;
  }

  /** A draft advisory: visible only to the repository's maintainers until they publish it. */
  async fileAdvisory(report: Report): Promise<string> {
    const { html_url } = await this.#post(`/repos/${this.repo}/security-advisories`, {
      summary: report.title,
      description: githubBody(report),
      severity: report.severity,
      vulnerabilities: [{ package: { ecosystem: "other", name: "AnvilCAD" } }],
    });
    return html_url;
  }
}
