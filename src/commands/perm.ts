import { OverwriteType, Role, type GuildMember, type NonThreadGuildBasedChannel } from "discord.js";
import { checkGrant } from "../auth.ts";
import { refuse, requireMember, requireRole, slash, type Command } from "../command.ts";
import { UserError } from "../errors.ts";
import { formatPermissions, parsePermissions, suggestPermissions } from "../perms.ts";
import { overwritesOf, resolveOverwrites } from "../snapshot.ts";

/** Apply allow/deny/reset to an existing overwrite. Pure, for testing. */
export function mergeOverwrite(
  current: { allow: bigint; deny: bigint },
  change: { allow: bigint; deny: bigint; reset: bigint },
): { allow: bigint; deny: bigint } {
  const allow = (current.allow | change.allow) & ~change.deny & ~change.reset;
  const deny = (current.deny | change.deny) & ~change.allow & ~change.reset;
  return { allow, deny };
}

export const perm: Command = {
  data: slash("perm", "Channel and category permissions")
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Allow, deny or reset permissions for a role or member in a channel or category")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel or category").setRequired(true))
        .addMentionableOption((o) => o.setName("for").setDescription("Role or member").setRequired(true))
        .addStringOption((o) => o.setName("allow").setDescription("Permissions to allow, comma-separated").setAutocomplete(true))
        .addStringOption((o) => o.setName("deny").setDescription("Permissions to deny, comma-separated").setAutocomplete(true))
        .addStringOption((o) =>
          o.setName("reset").setDescription("Permissions to set back to neutral (inherit), comma-separated").setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("clear")
        .setDescription("Remove a role's or member's overrides in a channel")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel or category").setRequired(true))
        .addMentionableOption((o) => o.setName("for").setDescription("Role or member").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("sync")
        .setDescription("Make a channel's permissions match its category")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("show")
        .setDescription("List a channel's permission overrides")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel or category").setRequired(true)),
    ),

  async autocomplete(interaction) {
    await interaction.respond(suggestPermissions(interaction.options.getFocused()));
  },

  async execute(session) {
    const { options, guild, actor, rules } = session;
    const reason = `Anvil, for ${session.member.user.tag}`;
    const sub = options.getSubcommand(true);
    const ch = options.getChannel("channel", true) as NonThreadGuildBasedChannel;
    if (ch.isThread()) throw new UserError("Threads take their permissions from their channel; pick the channel instead.");
    const previous = overwritesOf(ch);
    const undo = { kind: "setOverwrites" as const, channelId: ch.id, overwrites: previous };

    if (sub === "show") {
      if (previous.length === 0) {
        await session.say(`<#${ch.id}> has no overrides; it uses ${ch.parentId ? "its category's and " : ""}the server's role permissions.`);
        return;
      }
      const lines = previous.map((o) => {
        const who = o.type === 0 ? (o.id === guild.id ? "@everyone" : `<@&${o.id}>`) : `<@${o.id}>`;
        return `${who}\n  allow: ${formatPermissions(BigInt(o.allow))}\n  deny: ${formatPermissions(BigInt(o.deny))}`;
      });
      const synced = "permissionsLocked" in ch && ch.permissionsLocked ? " (synced with its category)" : "";
      await session.say(`Overrides in <#${ch.id}>${synced}:\n${lines.join("\n")}`.slice(0, 2000));
      return;
    }

    if (sub === "sync") {
      if (!ch.parent) throw new UserError(`<#${ch.id}> is not in a category.`);
      await ch.lockPermissions();
      await session.done(`Synced <#${ch.id}>'s permissions with **${ch.parent.name}**`, undo);
      return;
    }

    const target = options.getMentionable("for", true);
    let id: string;
    let type: OverwriteType;
    let label: string;
    if (target instanceof Role) {
      requireRole(actor, target, rules);
      [id, type, label] = [target.id, OverwriteType.Role, target.id === guild.id ? "@everyone" : `<@&${target.id}>`];
    } else {
      const member = "guild" in target ? (target as GuildMember) : await guild.members.fetch(target.id).catch(() => null);
      if (!member) throw new UserError("That person is not in the server.");
      requireMember(actor, member, rules);
      [id, type, label] = [member.id, OverwriteType.Member, `<@${member.id}>`];
    }
    const existing = ch.permissionOverwrites.cache.get(id);
    const current = { allow: existing?.allow.bitfield ?? 0n, deny: existing?.deny.bitfield ?? 0n };

    let next: { allow: bigint; deny: bigint };
    if (sub === "clear") {
      if (!existing) throw new UserError(`${label} has no overrides in <#${ch.id}>.`);
      next = { allow: 0n, deny: 0n };
    } else {
      const change = {
        allow: parsePermissions(options.getString("allow")),
        deny: parsePermissions(options.getString("deny")),
        reset: parsePermissions(options.getString("reset")),
      };
      if ((change.allow | change.deny | change.reset) === 0n) {
        throw new UserError("Say what to change: give allow, deny or reset.");
      }
      if ((change.allow & change.deny) !== 0n) {
        throw new UserError(`You both allowed and denied ${formatPermissions(change.allow & change.deny)}; pick one.`);
      }
      refuse(checkGrant(actor, change.allow & ~current.allow));
      next = mergeOverwrite(current, change);
    }

    const others = previous.filter((o) => o.id !== id);
    const resolved = resolveOverwrites(guild, others);
    if (next.allow !== 0n || next.deny !== 0n) resolved.push({ id, type, allow: next.allow, deny: next.deny });
    await ch.permissionOverwrites.set(resolved, reason);

    const summary =
      sub === "clear"
        ? `Removed ${label}'s overrides in <#${ch.id}>`
        : `Set ${label}'s permissions in <#${ch.id}>: allow ${formatPermissions(next.allow)}; deny ${formatPermissions(next.deny)}`;
    await session.done(summary, undo);
  },
};
