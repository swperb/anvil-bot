// Triage of bug reports: the buttons in each report's private thread, the
// decisions they lead to, and the points and rank roles that follow.
//
// Buttons carry the report number in their ID (bounty:<action>:<id>), so they
// keep working after Anvil restarts.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from "discord.js";
import { checkAuthorised, type Actor } from "../auth.ts";
import type { Audit } from "../audit.ts";
import { describeError, UserError } from "../errors.ts";
import { log } from "../log.ts";
import { textInput } from "../session.ts";
import { OPEN_STATUSES, POINTS, RANKS, rankFor, SEVERITIES, SEVERITY_MEANING, type BountyStore, type Report, type Severity } from "./store.ts";

export interface BountyDeps {
  store: BountyStore;
  audit: Audit;
  adminRoleId: string | null;
  /** Called after a report is accepted (files it on GitHub when that is set up). */
  onAccepted?: (guild: Guild, report: Report) => Promise<string | null>;
}

const RED = 0xed4245;
const BLUE = 0x5865f2;
const STATUS_COLOR: Record<Report["status"], number> = {
  open: BLUE,
  "needs-info": 0xfaa61a,
  accepted: 0x3ba55d,
  duplicate: 0x747f8d,
  rejected: 0x747f8d,
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export function reportEmbed(report: Report): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(report.security && OPEN_STATUSES.includes(report.status) ? RED : STATUS_COLOR[report.status])
    .setTitle(clip(`#${report.id} ${report.security ? "[security] " : ""}${report.title}`, 256))
    .addFields(
      { name: "What went wrong", value: clip(report.what, 1024) },
      { name: "Steps to reproduce", value: clip(report.steps, 1024) },
      { name: "Version and system", value: clip(report.environment, 1024), inline: true },
      { name: "Reported by", value: `<@${report.reporterId}>`, inline: true },
      { name: "Credit as", value: report.credit ? clip(report.credit, 100) : "anonymous", inline: true },
      { name: "Status", value: statusLine(report) },
    )
    .setTimestamp(new Date(report.createdAt));
  if (report.security) {
    embed.setDescription("Security report: keep it inside this thread until the fix is published.");
  }
  return embed;
}

export function statusLine(report: Report): string {
  switch (report.status) {
    case "open":
      return "Waiting for an admin to look at it.";
    case "needs-info":
      return `An admin asked for more information: ${report.note ?? ""}`;
    case "accepted":
      return `Confirmed as **${report.severity}** (+${report.severity ? POINTS[report.severity] : 0} points) by <@${report.decidedBy}>.${report.github ? ` Filed as ${report.github.url}` : ""}`;
    case "duplicate":
      return `Duplicate of ${report.note ?? "an earlier report"}; no points.`;
    case "rejected":
      return `Not taken: ${report.note ?? "no reason given"}`;
  }
}

export function triageRow(id: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`bounty:accept:${id}`).setLabel("Confirm bug").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`bounty:info:${id}`).setLabel("Ask for info").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`bounty:dup:${id}`).setLabel("Duplicate").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`bounty:reject:${id}`).setLabel("Not a bug").setStyle(ButtonStyle.Danger),
  );
}

/** Make the member's rank role match their points; create rank roles the first time they are needed. */
export async function syncRank(guild: Guild, store: BountyStore, userId: string): Promise<string | null> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  const want = rankFor(store.pointsOf(userId).points);
  let gained: string | null = null;
  for (const rank of RANKS) {
    let id = store.roleId(rank.key);
    if (id && !guild.roles.cache.has(id)) id = null;
    if (rank.key === want && !id) {
      const role = await guild.roles.create({
        name: rank.name,
        colors: { primaryColor: rank.color },
        permissions: [],
        reason: "Anvil: bug bounty rank",
      });
      store.setRole(rank.key, role.id);
      id = role.id;
    }
    if (!id) continue;
    const has = member.roles.cache.has(id);
    if (rank.key === want && !has) {
      await member.roles.add(id, "Anvil: bug bounty points");
      gained = rank.name;
    } else if (rank.key !== want && has) {
      await member.roles.remove(id, "Anvil: bug bounty points");
    }
  }
  return gained;
}

async function threadOf(guild: Guild, report: Report): Promise<ThreadChannel | null> {
  if (!report.threadId) return null;
  const ch = await guild.channels.fetch(report.threadId).catch(() => null);
  return ch?.isThread() ? ch : null;
}

/** Refresh the report message in its thread (embed and, while open, the buttons). */
export async function refreshReportMessage(guild: Guild, report: Report): Promise<void> {
  const thread = await threadOf(guild, report);
  if (!thread || !report.messageId) return;
  if (thread.archived) await thread.setArchived(false);
  const message = await thread.messages.fetch(report.messageId).catch(() => null);
  const open = OPEN_STATUSES.includes(report.status);
  await message?.edit({ embeds: [reportEmbed(report)], components: open ? [triageRow(report.id)] : [] });
}

/** Record a final decision, tell the reporter, update points and roles, and close the thread. */
async function finalise(
  guild: Guild,
  deps: BountyDeps,
  report: Report,
  actorId: string,
  decision: { status: "accepted" | "duplicate" | "rejected"; severity?: Severity; note?: string },
): Promise<string> {
  const updated = deps.store.update(report.id, {
    status: decision.status,
    severity: decision.severity ?? null,
    note: decision.note ?? null,
    decidedAt: new Date().toISOString(),
    decidedBy: actorId,
  });
  let filed: string | null = null;
  if (decision.status === "accepted" && deps.onAccepted) {
    try {
      filed = await deps.onAccepted(guild, updated);
    } catch (err) {
      log.error(`Filing report #${report.id} on GitHub failed`, err);
      filed = `Could not file it on GitHub (${err instanceof Error ? err.message : "unknown error"}); an admin will file it by hand.`;
    }
    Object.assign(updated, deps.store.get(report.id));
  }
  const rank = await syncRank(guild, deps.store, updated.reporterId);
  await refreshReportMessage(guild, updated);

  const thread = await threadOf(guild, updated);
  const total = deps.store.pointsOf(updated.reporterId).points;
  const lines = [`<@${updated.reporterId}>, ${statusLine(updated)}`];
  if (decision.status === "accepted") lines.push(`You now have ${total} points.${rank ? ` You are now a **${rank}**.` : ""} Thank you!`);
  if (filed) lines.push(filed);
  if (thread) {
    await thread.send({ content: lines.join("\n"), allowedMentions: { users: [updated.reporterId] } });
    await thread.setLocked(true, "Anvil: report decided");
    await thread.setArchived(true, "Anvil: report decided");
  }

  // A public thank-you for confirmed bugs, without details for security reports.
  if (decision.status === "accepted" && deps.store.channelId) {
    const channel = guild.channels.cache.get(deps.store.channelId);
    if (channel?.type === ChannelType.GuildText) {
      const what = updated.security ? "a security report" : `bug #${updated.id}, **${clip(updated.title, 100)}**`;
      await channel.send({
        content: `<@${updated.reporterId}> found ${what} (${updated.severity}, +${POINTS[updated.severity!]} points).${rank ? ` New rank: **${rank}**!` : ""}`,
        allowedMentions: { users: [updated.reporterId] },
      });
    }
  }
  await deps.audit.note(guild, `Bug bounty: <@${actorId}> marked report #${updated.id} as ${decision.status}${decision.severity ? ` (${decision.severity})` : ""}.`);
  return statusLine(updated);
}

type Component = ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached"> | ModalSubmitInteraction<"cached">;

/** Handle a bounty:* button, menu or form. */
export async function handleBountyComponent(interaction: Component, actor: Actor, deps: BountyDeps): Promise<void> {
  const [, action, idText] = interaction.customId.split(":");
  const id = Number(idText);
  const ephemeral = { flags: MessageFlags.Ephemeral } as const;
  try {
    const refusal = checkAuthorised(actor);
    if (refusal) throw new UserError("Only the server owner and Anvil Admins can triage bug reports.");
    const report = deps.store.get(id);
    if (!report) throw new UserError(`There is no report #${idText}.`);
    if (report.reporterId === actor.id && !actor.isOwner) throw new UserError("You cannot triage your own report; another admin has to.");
    if (!OPEN_STATUSES.includes(report.status)) {
      throw new UserError(`Report #${id} was already decided: ${statusLine(report)} Use \`/triage reopen\` to change it.`);
    }
    const guild = interaction.guild;

    if (interaction.isButton()) {
      if (action === "accept") {
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`bounty:severity:${id}`)
          .setPlaceholder("How bad is it?")
          .addOptions(SEVERITIES.map((s) => ({ label: `${s} (+${POINTS[s]} points)`, description: SEVERITY_MEANING[s], value: s })));
        await interaction.reply({
          ...ephemeral,
          content: `Confirm report #${id} as a bug. Pick its severity:`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
        });
        return;
      }
      const forms: Record<string, { title: string; label: string; placeholder: string }> = {
        info: { title: "Ask the reporter", label: "What do you need from them?", placeholder: "e.g. the file that crashes, or a screenshot" },
        dup: { title: "Duplicate report", label: "Duplicate of (report # or GitHub link)", placeholder: "#12 or https://github.com/swperb/anvilcad/issues/34" },
        reject: { title: "Not a bug", label: "Why not? (the reporter sees this)", placeholder: "e.g. works as designed: ..." },
      };
      const form = forms[action ?? ""];
      if (!form) throw new UserError("Unknown button.");
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`bounty:${action}form:${id}`)
          .setTitle(form.title)
          .addComponents(
            new ActionRowBuilder<ReturnType<typeof textInput>>().addComponents(
              textInput({ id: "text", label: form.label, placeholder: form.placeholder, maxLength: 500, paragraph: action !== "dup" }),
            ),
          ),
      );
      return;
    }

    if (interaction.isStringSelectMenu() && action === "severity") {
      const severity = interaction.values[0] as Severity;
      if (!SEVERITIES.includes(severity)) throw new UserError("Unknown severity.");
      await interaction.update({ content: `Confirming report #${id} as ${severity}...`, components: [] });
      const result = await finalise(guild, deps, report, actor.id, { status: "accepted", severity });
      await interaction.editReply({ content: `Done: report #${id}. ${result}` });
      return;
    }

    if (interaction.isModalSubmit()) {
      const text = interaction.fields.getTextInputValue("text").trim();
      await interaction.deferReply(ephemeral);
      if (action === "infoform") {
        const updated = deps.store.update(id, { status: "needs-info", note: text });
        await refreshReportMessage(guild, updated);
        const thread = await threadOf(guild, updated);
        await thread?.send({
          content: `<@${updated.reporterId}>, an admin needs more information before deciding:\n> ${text.replace(/\n/g, "\n> ")}\nPlease reply in this thread.`,
          allowedMentions: { users: [updated.reporterId] },
        });
        await deps.audit.note(guild, `Bug bounty: <@${actor.id}> asked for more information on report #${id}.`);
        await interaction.editReply("Asked the reporter in the thread.");
        return;
      }
      if (action === "dupform") {
        const ref = /^#?(\d+)$/.exec(text);
        if (ref && Number(ref[1]) === id) throw new UserError("A report cannot duplicate itself.");
        if (ref && !deps.store.get(Number(ref[1]))) throw new UserError(`There is no report #${ref[1]}.`);
        const note = ref ? `report #${ref[1]}` : text;
        const result = await finalise(guild, deps, report, actor.id, { status: "duplicate", note });
        await interaction.editReply(`Done: report #${id}. ${result}`);
        return;
      }
      if (action === "rejectform") {
        const result = await finalise(guild, deps, report, actor.id, { status: "rejected", note: text });
        await interaction.editReply(`Done: report #${id}. ${result}`);
        return;
      }
    }
    throw new UserError("Unknown action.");
  } catch (err) {
    if (!(err instanceof UserError)) log.error(`Bounty ${interaction.customId} failed`, err);
    const content = describeError(err);
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [] }).catch(() => undefined);
    else await interaction.reply({ ...ephemeral, content }).catch(() => undefined);
  }
}
