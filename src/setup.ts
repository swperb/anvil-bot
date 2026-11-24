// First-start setup: the Anvil Admin role and the private #anvil-log channel.
//
// Both are remembered by ID in DATA_DIR/state.json (or pinned with
// ADMIN_ROLE_ID / LOG_CHANNEL_ID), so renaming them is safe and creating
// another role called "Anvil Admin" grants nothing.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild } from "discord.js";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

export interface State {
  adminRoleId: string | null;
  logChannelId: string | null;
}

export function loadState(dataDir: string): State {
  const path = join(dataDir, "state.json");
  if (!existsSync(path)) return { adminRoleId: null, logChannelId: null };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
  return { adminRoleId: raw.adminRoleId ?? null, logChannelId: raw.logChannelId ?? null };
}

function saveState(dataDir: string, state: State): void {
  const path = join(dataDir, "state.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

/** Make sure the admin role and log channel exist; create them if not. */
export async function ensureSetup(guild: Guild, config: Config, state: State): Promise<State> {
  const me = await guild.members.fetchMe();
  const next: State = { ...state };

  const roleId = config.adminRoleId ?? state.adminRoleId;
  if (roleId && guild.roles.cache.has(roleId)) {
    next.adminRoleId = roleId;
  } else if (config.adminRoleId) {
    throw new Error(`ADMIN_ROLE_ID ${config.adminRoleId} is not a role in ${guild.name}.`);
  } else {
    const role = await guild.roles.create({
      name: "Anvil Admin",
      permissions: [],
      reason: "Anvil: members with this role may command Anvil",
    });
    next.adminRoleId = role.id;
    log.info(`Created the Anvil Admin role (${role.id}). Give it to the people who may command Anvil.`);
  }

  const channelId = config.logChannelId ?? state.logChannelId;
  if (channelId && guild.channels.cache.get(channelId)?.isTextBased()) {
    next.logChannelId = channelId;
  } else if (config.logChannelId) {
    throw new Error(`LOG_CHANNEL_ID ${config.logChannelId} is not a text channel in ${guild.name}.`);
  } else {
    const channel = await guild.channels.create({
      name: "anvil-log",
      type: ChannelType.GuildText,
      topic: "What Anvil changed, who asked, and how to undo it. Only Anvil can post here.",
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: next.adminRoleId!,
          type: OverwriteType.Role,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        },
        {
          id: me.id,
          type: OverwriteType.Member,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
        },
      ],
      reason: "Anvil: audit log",
    });
    next.logChannelId = channel.id;
    log.info(`Created the private #anvil-log channel (${channel.id}).`);
  }

  if (next.adminRoleId !== state.adminRoleId || next.logChannelId !== state.logChannelId) {
    saveState(config.dataDir, next);
  }
  return next;
}
