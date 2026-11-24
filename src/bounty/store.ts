// The bug bounty's records: reports, their triage decisions and the points they earn.
//
// Kept in DATA_DIR/bounty.json, rewritten atomically on every change. Points are
// never stored on their own: a member's total is the sum over their accepted
// reports, so reopening or re-deciding a report corrects the total by itself.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const POINTS: Record<Severity, number> = { low: 10, medium: 25, high: 50, critical: 100 };

export const SEVERITY_MEANING: Record<Severity, string> = {
  low: "cosmetic, or a minor annoyance with an easy workaround",
  medium: "a feature works wrongly, or the workaround is awkward",
  high: "a crash, wrong geometry, or a broken workflow with no workaround",
  critical: "lost work, a corrupted file, or a security hole",
};

/** Roles earned by total points, lowest first. */
export const RANKS = [
  { key: "hunter", name: "Bug Hunter", min: 10, color: 0x57a773 },
  { key: "senior", name: "Senior Bug Hunter", min: 100, color: 0x3d8fd6 },
  { key: "master", name: "Master Bug Hunter", min: 250, color: 0xd4a017 },
] as const;
export type RankKey = (typeof RANKS)[number]["key"];

/** The ranks a member holds at this many points: only the highest one reached. */
export function rankFor(points: number): RankKey | null {
  let best: RankKey | null = null;
  for (const rank of RANKS) if (points >= rank.min) best = rank.key;
  return best;
}

export type Status = "open" | "needs-info" | "accepted" | "duplicate" | "rejected";
export const OPEN_STATUSES: readonly Status[] = ["open", "needs-info"];

export interface Report {
  id: number;
  reporterId: string;
  reporterTag: string;
  title: string;
  what: string;
  steps: string;
  environment: string;
  /** Name to credit publicly, or null to stay anonymous. */
  credit: string | null;
  security: boolean;
  status: Status;
  severity: Severity | null;
  threadId: string | null;
  messageId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Reason for rejection, what a duplicate duplicates, or what info was asked for. */
  note: string | null;
  github: { kind: "issue" | "advisory"; url: string } | null;
}

export interface BountyData {
  channelId: string | null;
  roleIds: Partial<Record<RankKey, string>>;
  nextId: number;
  reports: Report[];
}

export const MAX_REPORTS_PER_DAY = 5;

export class BountyStore {
  #path: string;
  #data: BountyData;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#data = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as BountyData)
      : { channelId: null, roleIds: {}, nextId: 1, reports: [] };
  }

  #save(): void {
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(this.#data, null, 2) + "\n");
    renameSync(`${this.#path}.tmp`, this.#path);
  }

  get channelId(): string | null {
    return this.#data.channelId;
  }

  setChannel(id: string | null): void {
    this.#data.channelId = id;
    this.#save();
  }

  roleId(rank: RankKey): string | null {
    return this.#data.roleIds[rank] ?? null;
  }

  setRole(rank: RankKey, id: string): void {
    this.#data.roleIds[rank] = id;
    this.#save();
  }

  create(fields: Pick<Report, "reporterId" | "reporterTag" | "title" | "what" | "steps" | "environment" | "credit" | "security">): Report {
    const report: Report = {
      ...fields,
      id: this.#data.nextId++,
      status: "open",
      severity: null,
      threadId: null,
      messageId: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null,
      github: null,
    };
    this.#data.reports.push(report);
    this.#save();
    return report;
  }

  get(id: number): Report | undefined {
    return this.#data.reports.find((r) => r.id === id);
  }

  update(id: number, patch: Partial<Omit<Report, "id">>): Report {
    const report = this.get(id);
    if (!report) throw new Error(`No report #${id}`);
    Object.assign(report, patch);
    this.#save();
    return report;
  }

  list(statuses?: readonly Status[]): Report[] {
    return this.#data.reports.filter((r) => !statuses || statuses.includes(r.status));
  }

  /** How many reports this member filed since `since` (for the daily limit). */
  countSince(userId: string, since: Date): number {
    return this.#data.reports.filter((r) => r.reporterId === userId && Date.parse(r.createdAt) >= since.getTime()).length;
  }

  pointsOf(userId: string): { points: number; accepted: number } {
    let points = 0;
    let accepted = 0;
    for (const r of this.#data.reports) {
      if (r.reporterId === userId && r.status === "accepted" && r.severity) {
        points += POINTS[r.severity];
        accepted++;
      }
    }
    return { points, accepted };
  }

  /** Members by points, highest first; ties go to whoever reached it first. */
  leaderboard(limit: number): { userId: string; points: number; accepted: number }[] {
    const totals = new Map<string, { points: number; accepted: number; last: number }>();
    for (const r of this.#data.reports) {
      if (r.status !== "accepted" || !r.severity) continue;
      const t = totals.get(r.reporterId) ?? { points: 0, accepted: 0, last: 0 };
      t.points += POINTS[r.severity];
      t.accepted++;
      t.last = Math.max(t.last, Date.parse(r.decidedAt ?? r.createdAt));
      totals.set(r.reporterId, t);
    }
    return [...totals.entries()]
      .sort(([, a], [, b]) => b.points - a.points || a.last - b.last)
      .slice(0, limit)
      .map(([userId, t]) => ({ userId, points: t.points, accepted: t.accepted }));
  }
}
