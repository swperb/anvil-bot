// Carry out an UndoOp from the journal.

import { ChannelType, type Guild, type GuildBasedChannel, type NonThreadGuildBasedChannel } from "discord.js";
import { UserError } from "./errors.ts";
import type { ChannelFields, GuildFields, RoleFields, UndoOp } from "./journal.ts";
import { overwriteOptions } from "./perms.ts";
import { resolveOverwrites } from "./snapshot.ts";

/** What undoing will do, for the confirmation prompt. */
export function describeUndo(op: UndoOp): string {
  switch (op.kind) {
    case "deleteChannel":
      return `delete <#${op.channelId}> and everything in it`;
    case "editChannel":
      return `put <#${op.channelId}>'s ${Object.keys(op.before).join(", ")} back`;
    case "recreateChannel":
      return `recreate **${op.snapshot.name}** with its permissions (not its messages)`;
    case "deleteRole":
      return `delete the role <@&${op.roleId}>`;
    case "editRole":
      return `put <@&${op.roleId}>'s ${Object.keys(op.before).join(", ")} back`;
    case "recreateRole":
      return `recreate the role **${op.snapshot.name}**, give it back to ${op.snapshot.memberIds.length} member(s) and restore its channel permissions`;
    case "memberRole":
      return `${op.add ? "give" : "take"} <@&${op.roleId}> ${op.add ? "to" : "from"} <@${op.userId}>`;
    case "setOverwrites":
      return `put <#${op.channelId}>'s permissions back`;
    case "deleteMessage":
      return "delete the message Anvil sent";
    case "editMessage":
      return "put the message's previous text back";
    case "pinMessage":
      return `${op.pin ? "pin" : "unpin"} the message`;
    case "editGuild":
      return `put the server's ${Object.keys(op.before).join(", ")} back`;
    case "removeTimeout":
      return `end <@${op.userId}>'s timeout`;
    case "unban":
      return `unban <@${op.userId}>`;
    case "ban":
      return `ban <@${op.userId}> again`;
    case "setNickname":
      return `set <@${op.userId}>'s nickname back to ${op.nickname ? `"${op.nickname}"` : "none"}`;
  }
}

/** Undoing these removes something, so /undo asks first. */
export function undoIsDestructive(op: UndoOp): boolean {
  return op.kind === "deleteChannel" || op.kind === "deleteRole" || op.kind === "ban" || op.kind === "deleteMessage";
}

function channel(guild: Guild, id: string): NonThreadGuildBasedChannel {
  const ch: GuildBasedChannel | undefined = guild.channels.cache.get(id);
  if (!ch || ch.isThread()) throw new UserError("That channel no longer exists, so there is nothing to undo.");
  return ch;
}

function role(guild: Guild, id: string) {
  const r = guild.roles.cache.get(id);
  if (!r) throw new UserError("That role no longer exists, so there is nothing to undo.");
  return r;
}

export async function applyChannelFields(ch: NonThreadGuildBasedChannel, fields: ChannelFields, reason: string) {
  await ch.edit({
    ...(fields.name !== undefined && { name: fields.name }),
    ...(fields.topic !== undefined && { topic: fields.topic }),
    ...(fields.parentId !== undefined && { parent: fields.parentId, lockPermissions: false }),
    ...(fields.rateLimitPerUser !== undefined && { rateLimitPerUser: fields.rateLimitPerUser }),
    ...(fields.nsfw !== undefined && { nsfw: fields.nsfw }),
    ...(fields.position !== undefined && { position: fields.position }),
    reason,
  });
}

export async function applyRoleFields(guild: Guild, roleId: string, fields: RoleFields, reason: string) {
  const r = role(guild, roleId);
  await r.edit({
    ...(fields.name !== undefined && { name: fields.name }),
    ...(fields.color !== undefined && { colors: { primaryColor: fields.color } }),
    ...(fields.hoist !== undefined && { hoist: fields.hoist }),
    ...(fields.mentionable !== undefined && { mentionable: fields.mentionable }),
    ...(fields.permissions !== undefined && { permissions: BigInt(fields.permissions) }),
    ...(fields.position !== undefined && { position: fields.position }),
    reason,
  });
}

export async function applyGuildFields(guild: Guild, fields: GuildFields, reason: string) {
  await guild.edit({
    ...(fields.name !== undefined && { name: fields.name }),
    ...(fields.description !== undefined && { description: fields.description }),
    ...(fields.verificationLevel !== undefined && { verificationLevel: fields.verificationLevel }),
    ...(fields.defaultMessageNotifications !== undefined && { defaultMessageNotifications: fields.defaultMessageNotifications }),
    ...(fields.systemChannelId !== undefined && { systemChannel: fields.systemChannelId }),
    ...(fields.rulesChannelId !== undefined && { rulesChannel: fields.rulesChannelId }),
    ...(fields.afkChannelId !== undefined && { afkChannel: fields.afkChannelId }),
    ...(fields.afkTimeout !== undefined && { afkTimeout: fields.afkTimeout }),
    ...(fields.iconURL !== undefined && { icon: fields.iconURL }),
    reason,
  });
}

/** Undo one change. Returns a summary of what was done. */
export async function runUndo(guild: Guild, op: UndoOp, reason: string): Promise<string> {
  switch (op.kind) {
    case "deleteChannel": {
      const ch = channel(guild, op.channelId);
      await ch.delete(reason);
      return `deleted **${ch.name}**`;
    }
    case "editChannel": {
      const ch = channel(guild, op.channelId);
      await applyChannelFields(ch, op.before, reason);
      return `put <#${ch.id}> back as it was`;
    }
    case "recreateChannel": {
      const s = op.snapshot;
      const parent = s.parentId && guild.channels.cache.has(s.parentId) ? s.parentId : null;
      const created = await guild.channels.create({
        name: s.name,
        type: s.type as ChannelType.GuildText,
        parent,
        position: s.position,
        permissionOverwrites: resolveOverwrites(guild, s.overwrites),
        ...(s.topic && { topic: s.topic }),
        ...(s.nsfw && { nsfw: true }),
        ...(s.rateLimitPerUser && { rateLimitPerUser: s.rateLimitPerUser }),
        ...(s.bitrate && { bitrate: s.bitrate }),
        ...(s.userLimit && { userLimit: s.userLimit }),
        reason,
      });
      let moved = 0;
      for (const childId of s.childIds) {
        const child = guild.channels.cache.get(childId);
        if (child && !child.isThread() && child.parentId === null) {
          await child.setParent(created.id, { lockPermissions: false, reason });
          moved++;
        }
      }
      return `recreated <#${created.id}>${moved ? ` and moved ${moved} channel(s) back into it` : ""}`;
    }
    case "deleteRole": {
      const r = role(guild, op.roleId);
      await r.delete(reason);
      return `deleted the role **${r.name}**`;
    }
    case "editRole": {
      await applyRoleFields(guild, op.roleId, op.before, reason);
      return `put <@&${op.roleId}> back as it was`;
    }
    case "recreateRole": {
      const s = op.snapshot;
      const created = await guild.roles.create({
        name: s.name,
        colors: { primaryColor: s.color },
        hoist: s.hoist,
        mentionable: s.mentionable,
        permissions: BigInt(s.permissions),
        reason,
      });
      await created.setPosition(Math.min(s.position, guild.members.me!.roles.highest.position - 1), { reason }).catch(() => undefined);
      let given = 0;
      for (const id of s.memberIds) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (member) {
          await member.roles.add(created, reason);
          given++;
        }
      }
      for (const o of s.channelOverwrites) {
        const ch = guild.channels.cache.get(o.channelId);
        if (!ch || ch.isThread()) continue;
        await ch.permissionOverwrites.create(created, overwriteOptions(BigInt(o.allow), BigInt(o.deny)), { reason });
      }
      return `recreated <@&${created.id}>, gave it to ${given} member(s) and restored it in ${s.channelOverwrites.length} channel(s)`;
    }
    case "memberRole": {
      const member = await guild.members.fetch(op.userId).catch(() => null);
      if (!member) throw new UserError("That person is no longer in the server, so there is nothing to undo.");
      const r = role(guild, op.roleId);
      if (op.add) await member.roles.add(r, reason);
      else await member.roles.remove(r, reason);
      return `${op.add ? "gave" : "took"} <@&${r.id}> ${op.add ? "to" : "from"} <@${member.id}>`;
    }
    case "setOverwrites": {
      const ch = channel(guild, op.channelId);
      await ch.permissionOverwrites.set(resolveOverwrites(guild, op.overwrites), reason);
      return `put <#${ch.id}>'s permissions back`;
    }
    case "deleteMessage":
    case "editMessage":
    case "pinMessage": {
      const ch = channel(guild, op.channelId);
      if (!ch.isTextBased()) throw new UserError("That channel no longer holds messages.");
      const message = await ch.messages.fetch(op.messageId).catch(() => null);
      if (!message) throw new UserError("That message no longer exists, so there is nothing to undo.");
      if (op.kind === "deleteMessage") {
        await message.delete();
        return `deleted the message in <#${ch.id}>`;
      }
      if (op.kind === "editMessage") {
        await message.edit({ content: op.content, allowedMentions: { parse: [] } });
        return `put the message in <#${ch.id}> back`;
      }
      if (op.pin) await message.pin(reason);
      else await message.unpin(reason);
      return `${op.pin ? "pinned" : "unpinned"} the message in <#${ch.id}>`;
    }
    case "editGuild": {
      await applyGuildFields(guild, op.before, reason);
      return "put the server settings back";
    }
    case "removeTimeout": {
      const member = await guild.members.fetch(op.userId);
      await member.timeout(null, reason);
      return `ended <@${member.id}>'s timeout`;
    }
    case "unban": {
      await guild.bans.remove(op.userId, reason);
      return `unbanned <@${op.userId}>`;
    }
    case "ban": {
      await guild.bans.create(op.userId, { reason });
      return `banned <@${op.userId}> again`;
    }
    case "setNickname": {
      const member = await guild.members.fetch(op.userId);
      await member.setNickname(op.nickname, reason);
      return `set <@${member.id}>'s nickname back`;
    }
  }
}
