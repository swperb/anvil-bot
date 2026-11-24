import { ChannelType, GuildDefaultMessageNotifications, GuildVerificationLevel } from "discord.js";
import { slash, type Command } from "../command.ts";
import { UserError } from "../errors.ts";
import type { GuildFields } from "../journal.ts";
import { applyGuildFields } from "../undo.ts";

const VERIFICATION: Record<string, GuildVerificationLevel> = {
  none: GuildVerificationLevel.None,
  low: GuildVerificationLevel.Low,
  medium: GuildVerificationLevel.Medium,
  high: GuildVerificationLevel.High,
  highest: GuildVerificationLevel.VeryHigh,
};
const NOTIFICATIONS: Record<string, GuildDefaultMessageNotifications> = {
  "all messages": GuildDefaultMessageNotifications.AllMessages,
  "only mentions": GuildDefaultMessageNotifications.OnlyMentions,
};
const AFK = [60, 300, 900, 1800, 3600];
const nameOf = <T>(table: Record<string, T>, value: T) => Object.entries(table).find(([, v]) => v === value)?.[0] ?? String(value);

const ICON_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_ICON_BYTES = 10 * 1024 * 1024;

export const server: Command = {
  data: slash("server", "Server settings")
    .addSubcommand((s) => s.setName("info").setDescription("Show the server's settings"))
    .addSubcommand((s) =>
      s
        .setName("edit")
        .setDescription("Change server settings")
        .addStringOption((o) => o.setName("name").setDescription("Server name").setMinLength(2).setMaxLength(100))
        .addStringOption((o) => o.setName("description").setDescription("Description (Community servers); '-' clears it").setMaxLength(120))
        .addAttachmentOption((o) => o.setName("icon").setDescription("New server icon (PNG, JPEG, GIF or WebP)"))
        .addStringOption((o) =>
          o
            .setName("verification")
            .setDescription("What new members need before they can talk")
            .addChoices(...Object.keys(VERIFICATION).map((k) => ({ name: k, value: k }))),
        )
        .addStringOption((o) =>
          o
            .setName("notifications")
            .setDescription("Default notification setting for members")
            .addChoices(...Object.keys(NOTIFICATIONS).map((k) => ({ name: k, value: k }))),
        )
        .addChannelOption((o) =>
          o.setName("system_channel").setDescription("Where Discord posts joins and boosts").addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((o) =>
          o.setName("rules_channel").setDescription("Rules channel (Community servers)").addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((o) => o.setName("afk_channel").setDescription("Voice channel for idle members").addChannelTypes(ChannelType.GuildVoice))
        .addIntegerOption((o) =>
          o
            .setName("afk_timeout")
            .setDescription("Minutes before idle members move to the AFK channel")
            .addChoices(...AFK.map((s) => ({ name: `${s / 60}`, value: s }))),
        ),
    ),

  async execute(session) {
    const { options, guild } = session;
    const sub = options.getSubcommand(true);

    if (sub === "info") {
      const lines = [
        `**${guild.name}** (${guild.id})`,
        `Owner: <@${guild.ownerId}>`,
        `Members: ${guild.memberCount}; channels: ${guild.channels.cache.size}; roles: ${guild.roles.cache.size}`,
        `Description: ${guild.description ?? "none"}`,
        `Verification: ${nameOf(VERIFICATION, guild.verificationLevel)}; default notifications: ${nameOf(NOTIFICATIONS, guild.defaultMessageNotifications)}`,
        `System channel: ${guild.systemChannelId ? `<#${guild.systemChannelId}>` : "none"}; rules channel: ${guild.rulesChannelId ? `<#${guild.rulesChannelId}>` : "none"}`,
        `AFK: ${guild.afkChannelId ? `<#${guild.afkChannelId}> after ${guild.afkTimeout / 60} min` : "none"}`,
        `Features: ${guild.features.length ? guild.features.join(", ") : "none"}`,
      ];
      await session.say(lines.join("\n"));
      return;
    }

    const after: GuildFields = {};
    const before: GuildFields = {};
    const name = options.getString("name");
    if (name !== null) [after.name, before.name] = [name, guild.name];
    const description = options.getString("description");
    if (description !== null) [after.description, before.description] = [description === "-" ? null : description, guild.description];
    const icon = options.getAttachment("icon");
    if (icon) {
      const host = new URL(icon.url).hostname;
      if (!ICON_HOSTS.has(host)) throw new UserError("The icon must be uploaded to Discord.");
      if (!icon.contentType?.startsWith("image/")) throw new UserError("The icon must be an image (PNG, JPEG, GIF or WebP).");
      if (icon.size > MAX_ICON_BYTES) throw new UserError("The icon must be under 10 MB.");
      [after.iconURL, before.iconURL] = [icon.url, guild.iconURL({ extension: "png", size: 1024 })];
    }
    const verification = options.getString("verification");
    if (verification !== null) [after.verificationLevel, before.verificationLevel] = [VERIFICATION[verification], guild.verificationLevel];
    const notifications = options.getString("notifications");
    if (notifications !== null) {
      [after.defaultMessageNotifications, before.defaultMessageNotifications] = [NOTIFICATIONS[notifications], guild.defaultMessageNotifications];
    }
    const system = options.getChannel("system_channel");
    if (system) [after.systemChannelId, before.systemChannelId] = [system.id, guild.systemChannelId];
    const rules = options.getChannel("rules_channel");
    if (rules) [after.rulesChannelId, before.rulesChannelId] = [rules.id, guild.rulesChannelId];
    const afk = options.getChannel("afk_channel");
    if (afk) [after.afkChannelId, before.afkChannelId] = [afk.id, guild.afkChannelId];
    const afkTimeout = options.getInteger("afk_timeout");
    if (afkTimeout !== null) [after.afkTimeout, before.afkTimeout] = [afkTimeout, guild.afkTimeout];
    if (Object.keys(after).length === 0) throw new UserError("Say what to change: give at least one option.");

    await applyGuildFields(guild, after, `Anvil, for ${session.member.user.tag}`);
    const what = Object.keys(after).map((k) => (k === "iconURL" ? "icon" : k)).join(", ");
    await session.done(`Changed the server's ${what}`, { kind: "editGuild", before });
  },
};
