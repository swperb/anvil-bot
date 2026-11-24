// Who may command Anvil, and what they may do with it.
//
// The rules, in order:
// 1. Only the server owner and members holding the Anvil Admin role (by ID,
//    so renaming another role to "Anvil Admin" grants nothing) may run commands.
// 2. Anvil Admins cannot use Anvil to give themselves or anyone more power than
//    they have: they cannot grant Administrator, cannot grant permissions they
//    do not hold, cannot touch the Anvil Admin role or any role with
//    Administrator, cannot act on roles at or above their own highest role, and
//    cannot act on the owner, on Anvil, or on members ranked at or above them.
// 3. The owner may do anything Discord itself allows.
//
// These functions take plain data so they can be tested without Discord.

import { PermissionFlagsBits } from "discord.js";
import { formatPermissions } from "./perms.ts";

export interface Actor {
  id: string;
  isOwner: boolean;
  hasAdminRole: boolean;
  /** Position of the member's highest role (0 is @everyone). */
  topRolePosition: number;
  /** The member's server-wide permissions. */
  permissions: bigint;
}

export interface RoleTarget {
  id: string;
  name: string;
  position: number;
  permissions: bigint;
  managed: boolean;
}

export interface MemberTarget {
  id: string;
  isOwner: boolean;
  topRolePosition: number;
}

export interface Rules {
  adminRoleId: string | null;
  botId: string;
  /** Position of Anvil's own highest role. Discord will not let it manage roles at or above it. */
  botTopRolePosition: number;
  /** Anvil's own log channel; only the owner may delete it. */
  logChannelId: string | null;
}

const ADMIN = PermissionFlagsBits.Administrator;

/** Returns null when the actor may use Anvil, or the reason they may not. */
export function checkAuthorised(actor: Actor): string | null {
  if (actor.isOwner || actor.hasAdminRole) return null;
  return "Only the server owner and members with the Anvil Admin role can use Anvil.";
}

export function isPrivilegedRole(role: RoleTarget, rules: Rules): boolean {
  return role.id === rules.adminRoleId || (role.permissions & ADMIN) !== 0n;
}

/** May the actor create, edit, delete, give or take this role? */
export function checkRoleTarget(actor: Actor, role: RoleTarget, rules: Rules): string | null {
  if (role.managed) {
    return `The role ${role.name} belongs to an integration or bot, so Discord does not let anyone change it by hand.`;
  }
  if (role.position >= rules.botTopRolePosition) {
    return `The role ${role.name} is at or above Anvil's own role. Drag Anvil's role higher in Server Settings > Roles, then try again.`;
  }
  if (actor.isOwner) return null;
  if (isPrivilegedRole(role, rules)) {
    return `Only the server owner can change ${role.name}, because it is the Anvil Admin role or has Administrator.`;
  }
  if (role.position >= actor.topRolePosition) {
    return `The role ${role.name} is at or above your own highest role, so you cannot change it.`;
  }
  return null;
}

/** May the actor grant these permissions (to a role or in a channel overwrite)? */
export function checkGrant(actor: Actor, bits: bigint): string | null {
  if (bits === 0n || actor.isOwner) return null;
  if ((bits & ADMIN) !== 0n) return "Only the server owner can grant Administrator.";
  if ((actor.permissions & ADMIN) !== 0n) return null;
  const missing = bits & ~actor.permissions;
  if (missing === 0n) return null;
  return `You cannot grant permissions you do not have yourself: ${formatPermissions(missing)}.`;
}

/** May the actor act on this member (roles, nickname, timeout, kick, ban, channel overwrites)? */
export function checkMemberTarget(actor: Actor, target: MemberTarget, rules: Rules): string | null {
  if (target.id === rules.botId) return "Anvil will not act on itself.";
  if (actor.isOwner) return null;
  if (target.isOwner) return "Only the server owner can use Anvil on the server owner.";
  if (target.id === actor.id) return "You cannot use Anvil on yourself; ask the server owner.";
  if (target.topRolePosition >= actor.topRolePosition) {
    return "That member's highest role is at or above yours, so you cannot act on them.";
  }
  return null;
}
