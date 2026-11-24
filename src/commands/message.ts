import { ChannelType, type Guild, type Message } from "discord.js";
import { slash, unescapeLines, type Command } from "../command.ts";
import { UserError } from "../errors.ts";

const TEXT_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
] as const;

const LINK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/;

/** Parse a message link (right-click a message > Copy Message Link). Pure, for testing. */
export function parseMessageLink(link: string): { guildId: string; channelId: string; messageId: string } {
  const m = LINK.exec(link.trim());
  if (!m?.[1] || !m[2] || !m[3]) {
    throw new UserError("That is not a message link. Right-click the message, choose Copy Message Link, and paste it.");
  }
  return { guildId: m[1], channelId: m[2], messageId: m[3] };
}

async function fetchLinked(guild: Guild, link: string): Promise<Message<true>> {
  const { guildId, channelId, messageId } = parseMessageLink(link);
  if (guildId !== guild.id) throw new UserError("That message is in another server.");
  const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!ch?.isTextBased()) throw new UserError("That message's channel no longer exists.");
  const message = await ch.messages.fetch(messageId).catch(() => null);
  if (!message) throw new UserError("That message no longer exists.");
  return message;
}

const excerpt = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text).replace(/\n/g, " ");

export const message: Command = {
  data: slash("message", "Send, edit, pin or delete messages")
    .addSubcommand((s) =>
      s
        .setName("send")
        .setDescription("Post a message as Anvil (leave text empty for a multi-line form)")
        .addChannelOption((o) => o.setName("channel").setDescription("Where").setRequired(true).addChannelTypes(...TEXT_TYPES))
        .addStringOption((o) => o.setName("text").setDescription("What to say; \\n starts a new line").setMaxLength(2000))
        .addBooleanOption((o) => o.setName("ping").setDescription("Let @everyone, @here and role mentions notify people (default: no)")),
    )
    .addSubcommand((s) =>
      s
        .setName("edit")
        .setDescription("Edit a message Anvil sent (leave text empty for a form)")
        .addStringOption((o) => o.setName("link").setDescription("The message link").setRequired(true))
        .addStringOption((o) => o.setName("text").setDescription("New text; \\n starts a new line").setMaxLength(2000)),
    )
    .addSubcommand((s) =>
      s
        .setName("delete")
        .setDescription("Delete one message (asks first)")
        .addStringOption((o) => o.setName("link").setDescription("The message link").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("purge")
        .setDescription("Delete recent messages in a channel (asks first)")
        .addChannelOption((o) => o.setName("channel").setDescription("Where").setRequired(true).addChannelTypes(...TEXT_TYPES))
        .addIntegerOption((o) =>
          o.setName("count").setDescription("How many of the latest messages to look at (1-100)").setRequired(true).setMinValue(1).setMaxValue(100),
        )
        .addUserOption((o) => o.setName("from").setDescription("Only delete messages from this person")),
    )
    .addSubcommand((s) =>
      s
        .setName("pin")
        .setDescription("Pin a message")
        .addStringOption((o) => o.setName("link").setDescription("The message link").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("unpin")
        .setDescription("Unpin a message")
        .addStringOption((o) => o.setName("link").setDescription("The message link").setRequired(true)),
    ),

  usesModal(interaction) {
    const sub = interaction.options.getSubcommand(false);
    return (sub === "send" || sub === "edit") && interaction.options.getString("text") === null;
  },

  async execute(session) {
    const { options, guild } = session;
    const reason = `Anvil, for ${session.member.user.tag}`;
    const sub = options.getSubcommand(true);

    if (sub === "send") {
      const ch = options.getChannel("channel", true, [...TEXT_TYPES]);
      const given = options.getString("text");
      const text = given !== null ? unescapeLines(given) : await session.promptText(`Message for #${ch.name}`, "Message");
      if (text === null) return;
      const ping = options.getBoolean("ping") ?? false;
      const sent = await ch.send({
        content: text,
        allowedMentions: ping ? { parse: ["everyone", "roles", "users"] } : { parse: [] },
      });
      await session.done(`Sent a message in <#${ch.id}>: "${excerpt(text)}" ([jump](${sent.url}))`, {
        kind: "deleteMessage",
        channelId: ch.id,
        messageId: sent.id,
      });
      return;
    }

    if (sub === "edit") {
      const given = options.getString("text");
      // A modal must be the first reply, so for the form we fetch after it closes.
      let text: string | null;
      let target: Message<true>;
      if (given === null) {
        const { channelId, messageId } = parseMessageLink(options.getString("link", true));
        const ch = guild.channels.cache.get(channelId);
        const cached = ch?.isTextBased() ? ch.messages.cache.get(messageId) : undefined;
        text = await session.promptText("Edit message", "New text", cached?.content ?? "");
        if (text === null) return;
        target = await fetchLinked(guild, options.getString("link", true));
      } else {
        text = unescapeLines(given);
        target = await fetchLinked(guild, options.getString("link", true));
      }
      if (target.author.id !== guild.members.me!.id) {
        throw new UserError("Discord only lets a bot edit its own messages. Send a new one with /message send.");
      }
      const before = target.content;
      await target.edit({ content: text, allowedMentions: { parse: [] } });
      await session.done(`Edited Anvil's message in <#${target.channelId}> ([jump](${target.url}))`, {
        kind: "editMessage",
        channelId: target.channelId,
        messageId: target.id,
        content: before,
      });
      return;
    }

    if (sub === "delete") {
      const target = await fetchLinked(guild, options.getString("link", true));
      const ok = await session.confirm(
        `Delete this message by <@${target.author.id}> in <#${target.channelId}>?\n> ${excerpt(target.content || "(no text)")}\nThis cannot be undone.`,
      );
      if (!ok) return;
      await target.delete();
      await session.done(`Deleted a message by <@${target.author.id}> in <#${target.channelId}>: "${excerpt(target.content)}"`, null);
      return;
    }

    if (sub === "purge") {
      const ch = options.getChannel("channel", true, [...TEXT_TYPES]);
      const count = options.getInteger("count", true);
      const from = options.getUser("from");
      const fetched = await ch.messages.fetch({ limit: count });
      const twoWeeks = Date.now() - 14 * 24 * 60 * 60 * 1000 + 60_000;
      const matching = fetched.filter((m) => !from || m.author.id === from.id);
      const deletable = matching.filter((m) => m.createdTimestamp > twoWeeks && !m.pinned);
      if (deletable.size === 0) {
        throw new UserError(
          "No messages to delete. Discord only bulk-deletes messages under 14 days old, and Anvil skips pinned ones.",
        );
      }
      const skipped = matching.size - deletable.size;
      const ok = await session.confirm(
        `Delete ${deletable.size} message(s)${from ? ` from <@${from.id}>` : ""} in <#${ch.id}>?` +
          `${skipped ? ` ${skipped} pinned or older message(s) will be left alone.` : ""}\nThis cannot be undone.`,
      );
      if (!ok) return;
      const deleted = await ch.bulkDelete(deletable, true);
      await session.done(`Deleted ${deleted.size} message(s)${from ? ` from <@${from.id}>` : ""} in <#${ch.id}>`, null);
      return;
    }

    // pin / unpin
    const target = await fetchLinked(guild, options.getString("link", true));
    const pin = sub === "pin";
    if (pin === target.pinned) throw new UserError(`That message is ${pin ? "already" : "not"} pinned.`);
    if (pin) await target.pin(reason);
    else await target.unpin(reason);
    await session.done(`${pin ? "Pinned" : "Unpinned"} a message in <#${target.channelId}> ([jump](${target.url}))`, {
      kind: "pinMessage",
      channelId: target.channelId,
      messageId: target.id,
      pin: !pin,
    });
  },
};
