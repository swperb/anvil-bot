import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type Guild,
  type TextChannel,
} from "discord.js";
import { checkAuthorised } from "../auth.ts";
import { slash, type Command } from "../command.ts";
import { UserError } from "../errors.ts";
import { overwritesOf } from "../snapshot.ts";
import type { Session } from "../session.ts";
import { rulesText } from "./rules.ts";
import { MAX_REPORTS_PER_DAY, OPEN_STATUSES, RANKS, type Status } from "./store.ts";
import { refreshReportMessage, reportEmbed, statusLine, syncRank, triageRow, type BountyDeps } from "./triage.ts";

const P = PermissionFlagsBits;

function deps(session: Session): BountyDeps {
  const d = session.services.bounty;
  if (!d) throw new UserError("The bug bounty is not available.");
  return d;
}

function bountyChannel(guild: Guild, d: BountyDeps): TextChannel | null {
  const ch = d.store.channelId ? guild.channels.cache.get(d.store.channelId) : undefined;
  return ch?.type === ChannelType.GuildText ? ch : null;
}

/** The program is open when everyone can see the bug-reports channel. */
export function isLaunched(guild: Guild, channel: TextChannel): boolean {
  return channel.permissionsFor(guild.roles.everyone).has(P.ViewChannel);
}

/** A slash command everyone in the server can use. */
function publicSlash(name: string, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
}

export const bug: Command = {
  public: true,
  data: publicSlash("bug", "Report a bug in AnvilCAD for the bug bounty").addBooleanOption((o) =>
    o.setName("security").setDescription("It is a security problem (stays private; becomes a private GitHub advisory)"),
  ),
  usesModal: () => true,

  async execute(session) {
    const d = deps(session);
    const { guild, actor, interaction } = session;
    const channel = bountyChannel(guild, d);
    const isAdmin = checkAuthorised(actor) === null;
    // Check before showing the form, so nobody fills it in for nothing. The
    // form must be the first reply, so these refusals are plain replies.
    const refuse = async (text: string) => {
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    };
    if (!channel) return refuse("The bug bounty is not set up yet. An admin can set it up with `/triage setup`.");
    if (!isLaunched(guild, channel) && !isAdmin) return refuse("The bug bounty is not open yet. Watch the announcements!");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (d.store.countSince(actor.id, since) >= MAX_REPORTS_PER_DAY && !isAdmin) {
      return refuse(`You have sent ${MAX_REPORTS_PER_DAY} reports in the last day, the most allowed. Please try again tomorrow.`);
    }
    const security = session.options.getBoolean("security") ?? false;

    const form = await session.promptForm(security ? "Report a security problem" : "Report a bug in AnvilCAD", [
      { id: "title", label: "Summary", placeholder: "e.g. Fillet on a chamfered edge crashes", maxLength: 100 },
      { id: "what", label: "What went wrong, and what did you expect?", paragraph: true, maxLength: 1000 },
      { id: "steps", label: "Steps to reproduce", placeholder: "1. Open ... 2. Click ... 3. See ...", paragraph: true, maxLength: 1000 },
      { id: "environment", label: "AnvilCAD version and operating system", placeholder: "e.g. 0.2.0 on Windows 11", maxLength: 100 },
      { id: "credit", label: "Name to credit on GitHub (blank: anonymous)", maxLength: 50, required: false },
    ]);
    if (!form) return;

    const report = d.store.create({
      reporterId: actor.id,
      reporterTag: session.member.user.tag,
      title: form.title ?? "",
      what: form.what ?? "",
      steps: form.steps ?? "",
      environment: form.environment ?? "",
      credit: form.credit || null,
      security,
    });
    const thread = await channel.threads.create({
      name: `#${report.id} ${security ? "security report" : report.title}`.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `Anvil: bug report #${report.id}`,
    });
    await thread.members.add(actor.id);
    const ping = session.rules.adminRoleId ? `<@&${session.rules.adminRoleId}> ` : "";
    const message = await thread.send({
      content: `${ping}New ${security ? "**security** " : ""}report from <@${actor.id}>. Admins: confirm it, ask for more, or close it with the buttons.`,
      embeds: [reportEmbed(report)],
      components: [triageRow(report.id)],
      allowedMentions: { roles: session.rules.adminRoleId ? [session.rules.adminRoleId] : [], users: [actor.id] },
    });
    d.store.update(report.id, { threadId: thread.id, messageId: message.id });
    await d.audit.note(guild, `Bug bounty: <@${actor.id}> sent ${security ? "security " : ""}report #${report.id} (<#${thread.id}>).`);
    await session.say(
      `Thank you! Report #${report.id} is in <#${thread.id}>, a private thread only you and the admins can see. ` +
        "They may ask you questions there, and you will be told when it is decided.",
    );
  },
};

export const bounty: Command = {
  public: true,
  data: publicSlash("bounty", "The AnvilCAD bug bounty")
    .addSubcommand((s) => s.setName("rules").setDescription("How the bug bounty works"))
    .addSubcommand((s) => s.setName("leaderboard").setDescription("The top bug hunters"))
    .addSubcommand((s) =>
      s
        .setName("points")
        .setDescription("Your points and rank, or someone else's")
        .addUserOption((o) => o.setName("member").setDescription("Whose (default: yours)")),
    ),

  async execute(session) {
    const d = deps(session);
    const sub = session.options.getSubcommand(true);
    if (sub === "rules") {
      await session.say(rulesText());
      return;
    }
    if (sub === "leaderboard") {
      const top = d.store.leaderboard(10);
      if (top.length === 0) {
        await session.say("No bugs have been confirmed yet. Be the first: `/bug`.");
        return;
      }
      const lines = top.map((t, i) => `**${i + 1}.** <@${t.userId}>: ${t.points} points (${t.accepted} bug${t.accepted === 1 ? "" : "s"})`);
      await session.say(`## Top bug hunters\n${lines.join("\n")}`);
      return;
    }
    const user = session.options.getUser("member") ?? session.member.user;
    const { points, accepted } = d.store.pointsOf(user.id);
    const next = RANKS.find((r) => r.min > points);
    const reached = [...RANKS].reverse().find((r) => r.min <= points);
    const who = user.id === session.actor.id ? "You have" : `<@${user.id}> has`;
    await session.say(
      `${who} ${points} points from ${accepted} confirmed bug${accepted === 1 ? "" : "s"}` +
        `${reached ? `, rank **${reached.name}**` : ""}.${next ? ` ${next.min - points} more for **${next.name}**.` : ""}`,
    );
  },
};

const STATUS_CHOICES: Status[] = ["open", "needs-info", "accepted", "duplicate", "rejected"];

export const triage: Command = {
  data: slash("triage", "Run the bug bounty")
    .addSubcommand((s) => s.setName("setup").setDescription("Create #bug-reports, hidden until /triage launch"))
    .addSubcommand((s) => s.setName("launch").setDescription("Open the bug bounty to everyone (asks first)"))
    .addSubcommand((s) =>
      s
        .setName("list")
        .setDescription("List reports (default: the ones waiting for a decision)")
        .addStringOption((o) => o.setName("status").setDescription("Which").addChoices(...STATUS_CHOICES.map((c) => ({ name: c, value: c })))),
    )
    .addSubcommand((s) =>
      s
        .setName("reopen")
        .setDescription("Undo a decision on a report (takes back its points)")
        .addIntegerOption((o) => o.setName("report").setDescription("Report number").setRequired(true).setMinValue(1)),
    ),

  async execute(session) {
    const d = deps(session);
    const { guild } = session;
    const reason = `Anvil, for ${session.member.user.tag}`;
    const sub = session.options.getSubcommand(true);

    if (sub === "setup") {
      const existing = bountyChannel(guild, d);
      if (existing) throw new UserError(`The bug bounty already uses <#${existing.id}>.`);
      const me = guild.members.me!;
      const adminRoleId = session.rules.adminRoleId;
      const channel = await guild.channels.create({
        name: "bug-reports",
        type: ChannelType.GuildText,
        topic: "Report AnvilCAD bugs with /bug. Each report gets a private thread. Rules: /bounty rules",
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            // Hidden until /triage launch. Members never post here directly;
            // they talk to the admins in their own private report thread.
            deny: [P.ViewChannel, P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads, P.AddReactions],
            allow: [P.ReadMessageHistory, P.SendMessagesInThreads, P.AttachFiles],
          },
          ...(adminRoleId
            ? [{ id: adminRoleId, type: OverwriteType.Role, allow: [P.ViewChannel, P.ManageThreads, P.SendMessagesInThreads] }]
            : []),
          {
            id: me.id,
            type: OverwriteType.Member,
            allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.CreatePrivateThreads, P.ManageThreads, P.SendMessagesInThreads, P.ManageMessages],
          },
        ],
        reason,
      });
      const rules = await channel.send({ content: rulesText(), allowedMentions: { parse: [] } });
      await rules.pin(reason);
      d.store.setChannel(channel.id);
      await session.done(
        `Set up the bug bounty in <#${channel.id}>, hidden from members until \`/triage launch\``,
        { kind: "deleteChannel", channelId: channel.id },
        "Try it yourself with /bug first; admins can report before launch.",
      );
      return;
    }

    const channel = bountyChannel(guild, d);
    if (!channel) throw new UserError("Set the bug bounty up first with `/triage setup`.");

    if (sub === "launch") {
      if (isLaunched(guild, channel)) throw new UserError(`The bug bounty is already open in <#${channel.id}>.`);
      const ok = await session.confirm(
        `Open the bug bounty? Everyone will see <#${channel.id}> and its pinned rules, and can send reports with \`/bug\`.\nRead the rules first with \`/bounty rules\`.`,
        "Yes, open it",
      );
      if (!ok) return;
      const before = overwritesOf(channel);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true }, { reason });
      await session.done(`Opened the bug bounty in <#${channel.id}> to everyone`, {
        kind: "setOverwrites",
        channelId: channel.id,
        overwrites: before,
      });
      return;
    }

    if (sub === "list") {
      const status = session.options.getString("status") as Status | null;
      const reports = d.store.list(status ? [status] : OPEN_STATUSES).slice(-20).reverse();
      if (reports.length === 0) {
        await session.say(status ? `No reports are ${status}.` : "No reports are waiting for a decision.");
        return;
      }
      const lines = reports.map(
        (r) => `**#${r.id}** ${r.security ? "[security] " : ""}${r.title.slice(0, 80)} by <@${r.reporterId}>${r.threadId ? ` <#${r.threadId}>` : ""} (${r.status})`,
      );
      await session.say(lines.join("\n").slice(0, 2000));
      return;
    }

    // reopen
    const id = session.options.getInteger("report", true);
    const report = d.store.get(id);
    if (!report) throw new UserError(`There is no report #${id}.`);
    if (OPEN_STATUSES.includes(report.status)) throw new UserError(`Report #${id} is still waiting for a decision.`);
    if (report.reporterId === session.actor.id && !session.actor.isOwner) throw new UserError("You cannot reopen your own report.");
    const was = statusLine(report);
    const updated = d.store.update(id, { status: "open", severity: null, note: null, decidedAt: null, decidedBy: null });
    await syncRank(guild, d.store, updated.reporterId);
    if (updated.threadId) {
      const thread = await guild.channels.fetch(updated.threadId).catch(() => null);
      if (thread?.isThread()) {
        await thread.setArchived(false, reason);
        await thread.setLocked(false, reason);
        await thread.send({ content: `An admin reopened this report; it is waiting for a new decision.`, allowedMentions: { parse: [] } });
      }
    }
    await refreshReportMessage(guild, updated);
    const github = report.github ? ` Its GitHub ${report.github.kind} (${report.github.url}) was left as it is.` : "";
    await session.done(`Reopened bug report #${id} (it was: ${was})`, null, `Points were recalculated.${github}`);
  },
};
