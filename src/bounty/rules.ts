// The bug bounty's public rules. Shown by /bounty rules and pinned in #bug-reports.

import { MAX_REPORTS_PER_DAY, POINTS, RANKS, SEVERITIES, SEVERITY_MEANING } from "./store.ts";

export const ISSUES_URL = "https://github.com/swperb/anvilcad/issues";

export function rulesText(): string {
  const points = SEVERITIES.map((s) => `- **${s}** (${POINTS[s]} points): ${SEVERITY_MEANING[s]}`).join("\n");
  const ranks = RANKS.map((r) => `**${r.name}** at ${r.min} points`).join(", ");
  return [
    "## AnvilCAD bug bounty",
    "Find a bug in AnvilCAD, report it here, and earn points, roles and credit when it is confirmed.",
    "",
    "**How to report:** type `/bug` in any channel and fill in the form. It goes into a private thread that only you and the admins can see.",
    "",
    "**In scope:** bugs in AnvilCAD itself, in the latest release or on `main`: crashes, wrong geometry or results, import and export errors, lost or corrupted work, and interface features that do not work as described.",
    `**Out of scope:** feature requests and ideas; bugs already open on GitHub (check ${ISSUES_URL} first); bugs in Discord, this bot or other tools; and anything found by attacking someone else's computer or data.`,
    "",
    "**Points**, set by the admins when they confirm a report:",
    points,
    `**Roles:** ${ranks}. Check yours with \`/bounty points\` and the top hunters with \`/bounty leaderboard\`.`,
    "**Credit:** confirmed bugs become GitHub issues that credit the name you give in the form (leave it blank to stay anonymous).",
    "There are no cash rewards.",
    "",
    "**Duplicates:** the first report of a bug earns the points. A later report of the same bug earns none.",
    "**Security problems:** run `/bug security:True`. The report stays private, becomes a private GitHub security advisory rather than a public issue, and is credited when the fix is published. Please do not post it anywhere else until then.",
    "",
    `**Fair play:** one bug per report, at most ${MAX_REPORTS_PER_DAY} reports a day. Points can be taken back if a report turns out to be wrong, copied or made up, and spam gets you removed from the program.`,
  ].join("\n");
}
