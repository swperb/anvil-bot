import { ChannelType, OverwriteType, PermissionFlagsBits, type NonThreadGuildBasedChannel } from "discord.js";
import { slash, type Command } from "../command.ts";
import { UserError } from "../errors.ts";
import type { ChannelFields } from "../journal.ts";
import { snapshotChannel } from "../snapshot.ts";
import { applyChannelFields } from "../undo.ts";

const TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
} as const;
type TypeName = keyof typeof TYPES;
const TYPE_LABEL: Record<number, string> = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
const NOT_THREADS = Object.values(TYPES);
const HAS_TOPIC = new Set<number>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]);

export const channel: Command = {
  data: slash("channel", "Create, change or delete channels and categories")
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create a channel or category")
        .addStringOption((o) => o.setName("name").setDescription("Its name").setRequired(true).setMaxLength(100))
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("What kind (default: text)")
            .addChoices(...Object.keys(TYPES).map((t) => ({ name: t, value: t }))),
        )
        .addChannelOption((o) =>
          o.setName("category").setDescription("The category to put it in").addChannelTypes(ChannelType.GuildCategory),
        )
        .addStringOption((o) => o.setName("topic").setDescription("Its topic (text, announcement and forum)").setMaxLength(1024))
        .addBooleanOption((o) => o.setName("private").setDescription("Hide it from @everyone (default: no)")),
    )
    .addSubcommand((s) =>
      s
        .setName("edit")
        .setDescription("Change a channel or category")
        .addChannelOption((o) => o.setName("channel").setDescription("Which one").setRequired(true).addChannelTypes(...NOT_THREADS))
        .addStringOption((o) => o.setName("name").setDescription("New name").setMaxLength(100))
        .addStringOption((o) => o.setName("topic").setDescription("New topic; '-' clears it").setMaxLength(1024))
        .addChannelOption((o) =>
          o.setName("category").setDescription("Move it into this category").addChannelTypes(ChannelType.GuildCategory),
        )
        .addBooleanOption((o) => o.setName("uncategorised").setDescription("Take it out of its category"))
        .addIntegerOption((o) =>
          o.setName("slowmode").setDescription("Seconds between messages per person (0 is off)").setMinValue(0).setMaxValue(21600),
        )
        .addBooleanOption((o) => o.setName("nsfw").setDescription("Age-restricted"))
        .addIntegerOption((o) => o.setName("position").setDescription("Position in its list (0 is the top)").setMinValue(0)),
    )
    .addSubcommand((s) =>
      s
        .setName("delete")
        .setDescription("Delete a channel or category (asks first)")
        .addChannelOption((o) => o.setName("channel").setDescription("Which one").setRequired(true).addChannelTypes(...NOT_THREADS)),
    ),

  async execute(session) {
    const { options, guild } = session;
    const reason = `Anvil, for ${session.member.user.tag}`;
    const sub = options.getSubcommand(true);

    if (sub === "create") {
      const name = options.getString("name", true);
      const typeName = (options.getString("type") ?? "text") as TypeName;
      const type = TYPES[typeName];
      const category = type === ChannelType.GuildCategory ? null : options.getChannel("category");
      const topic = HAS_TOPIC.has(type) ? options.getString("topic") : null;
      const hidden = options.getBoolean("private") ?? false;
      const created = await guild.channels.create({
        name,
        type: type as ChannelType.GuildText,
        parent: category?.id ?? null,
        ...(topic && { topic }),
        ...(hidden && {
          permissionOverwrites: [
            { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.members.me!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel] },
          ],
        }),
        reason,
      });
      await session.done(
        `Created ${hidden ? "private " : ""}${typeName} **${created.name}** (<#${created.id}>)${category ? ` in **${category.name}**` : ""}`,
        { kind: "deleteChannel", channelId: created.id },
      );
      return;
    }

    const ch = options.getChannel("channel", true) as NonThreadGuildBasedChannel;

    if (sub === "edit") {
      const after: ChannelFields = {};
      const name = options.getString("name");
      if (name !== null) after.name = name;
      const topic = options.getString("topic");
      if (topic !== null) {
        if (!("topic" in ch)) throw new UserError(`A ${TYPE_LABEL[ch.type] ?? "channel"} channel has no topic.`);
        after.topic = topic === "-" ? null : topic;
      }
      const category = options.getChannel("category");
      if (category) {
        if (ch.type === ChannelType.GuildCategory) throw new UserError("A category cannot go inside another category.");
        after.parentId = category.id;
      } else if (options.getBoolean("uncategorised")) {
        after.parentId = null;
      }
      const slowmode = options.getInteger("slowmode");
      if (slowmode !== null) {
        if (!("rateLimitPerUser" in ch)) throw new UserError("That kind of channel has no slowmode.");
        after.rateLimitPerUser = slowmode;
      }
      const nsfw = options.getBoolean("nsfw");
      if (nsfw !== null) {
        if (!("nsfw" in ch)) throw new UserError("That kind of channel cannot be age-restricted.");
        after.nsfw = nsfw;
      }
      const position = options.getInteger("position");
      if (position !== null) after.position = position;
      if (Object.keys(after).length === 0) throw new UserError("Say what to change: give at least one option besides the channel.");

      const before: ChannelFields = {};
      if ("name" in after) before.name = ch.name;
      if ("topic" in after) before.topic = "topic" in ch ? (ch.topic ?? null) : null;
      if ("parentId" in after) before.parentId = ch.parentId;
      if ("rateLimitPerUser" in after) before.rateLimitPerUser = "rateLimitPerUser" in ch ? (ch.rateLimitPerUser ?? 0) : 0;
      if ("nsfw" in after) before.nsfw = "nsfw" in ch ? ch.nsfw : false;
      if ("position" in after) before.position = ch.position;

      await applyChannelFields(ch, after, reason);
      await session.done(`Changed ${Object.keys(after).join(", ")} of <#${ch.id}>`, {
        kind: "editChannel",
        channelId: ch.id,
        before,
      });
      return;
    }

    if (sub === "delete") {
      if (ch.id === session.rules.logChannelId && !session.actor.isOwner) {
        throw new UserError("Only the server owner can delete Anvil's log channel.");
      }
      const snapshot = snapshotChannel(ch);
      const isCategory = ch.type === ChannelType.GuildCategory;
      const warning = isCategory
        ? `Its ${snapshot.childIds.length} channel(s) will be left without a category; /undo puts them back.`
        : "Its messages are deleted for good; /undo recreates the channel and its permissions, but not its messages.";
      if (!(await session.confirm(`Delete ${isCategory ? "category" : "channel"} **${ch.name}** (<#${ch.id}>)?\n${warning}`))) return;
      await ch.delete(reason);
      await session.done(`Deleted ${TYPE_LABEL[ch.type] ?? "channel"} **${ch.name}**`, { kind: "recreateChannel", snapshot });
    }
  },
};
