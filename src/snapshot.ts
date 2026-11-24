// Capture enough of a channel or role to put it back after it is deleted.

import {
  ChannelType,
  OverwriteType,
  type Guild,
  type GuildChannel,
  type NonThreadGuildBasedChannel,
  type OverwriteResolvable,
  type Role,
} from "discord.js";
import type { ChannelSnapshot, OverwriteSnapshot, RoleSnapshot } from "./journal.ts";

export function overwritesOf(channel: GuildChannel): OverwriteSnapshot[] {
  return channel.permissionOverwrites.cache.map((o) => ({
    id: o.id,
    type: o.type === OverwriteType.Member ? 1 : 0,
    allow: o.allow.bitfield.toString(),
    deny: o.deny.bitfield.toString(),
  }));
}

/** Overwrites in the form discord.js accepts, dropping roles and members that no longer exist. */
export function resolveOverwrites(guild: Guild, overwrites: OverwriteSnapshot[]): OverwriteResolvable[] {
  return overwrites
    .filter((o) => (o.type === 0 ? guild.roles.cache.has(o.id) : true))
    .map((o) => ({
      id: o.id,
      type: o.type === 1 ? OverwriteType.Member : OverwriteType.Role,
      allow: BigInt(o.allow),
      deny: BigInt(o.deny),
    }));
}

export function snapshotChannel(channel: NonThreadGuildBasedChannel): ChannelSnapshot {
  const childIds =
    channel.type === ChannelType.GuildCategory ? channel.children.cache.map((c) => c.id) : [];
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    topic: "topic" in channel ? (channel.topic ?? null) : null,
    parentId: channel.parentId,
    position: channel.position,
    nsfw: "nsfw" in channel ? channel.nsfw : false,
    rateLimitPerUser: "rateLimitPerUser" in channel ? (channel.rateLimitPerUser ?? 0) : 0,
    bitrate: "bitrate" in channel ? channel.bitrate : null,
    userLimit: "userLimit" in channel ? channel.userLimit : null,
    overwrites: overwritesOf(channel),
    childIds,
  };
}

/** Snapshot a role. Fetches the member list first so role.members is complete. */
export async function snapshotRole(guild: Guild, role: Role): Promise<RoleSnapshot> {
  await guild.members.fetch();
  const channelOverwrites: RoleSnapshot["channelOverwrites"] = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread()) continue;
    const o = channel.permissionOverwrites.cache.get(role.id);
    if (o) channelOverwrites.push({ channelId: channel.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() });
  }
  return {
    id: role.id,
    name: role.name,
    color: role.colors.primaryColor,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
    memberIds: role.members.map((m) => m.id),
    channelOverwrites,
  };
}
