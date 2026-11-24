import { PermissionFlagsBits } from "discord.js";
import { UserError } from "./errors.ts";

type FlagName = keyof typeof PermissionFlagsBits;

// Deprecated aliases that share a bit with a current name.
const ALIASES = new Set<string>(["ManageEmojisAndStickers"]);

/** Every permission name Anvil accepts, in Discord's order. */
export const PERMISSION_NAMES: readonly FlagName[] = (Object.keys(PermissionFlagsBits) as FlagName[]).filter(
  (name) => !ALIASES.has(name),
);

const normalise = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
const BY_KEY = new Map<string, FlagName>(PERMISSION_NAMES.map((name) => [normalise(name), name]));
// Accept the names people see in Discord's settings too.
const FRIENDLY: Record<string, FlagName> = {
  managepermissions: "ManageRoles",
  manageserver: "ManageGuild",
  readmessages: "ViewChannel",
  timeoutmembers: "ModerateMembers",
  manageexpressions: "ManageGuildExpressions",
  mentioneveryonehereandallroles: "MentionEveryone",
  usevoiceactivity: "UseVAD",
};

/** Look up one permission by name, ignoring case, spaces and underscores. */
export function permissionByName(input: string): FlagName | null {
  const key = normalise(input);
  return BY_KEY.get(key) ?? FRIENDLY[key] ?? null;
}

/**
 * Parse a comma-separated list such as "View Channel, SendMessages".
 * An empty string is no permissions.
 */
export function parsePermissions(input: string | null | undefined): bigint {
  let bits = 0n;
  const unknown: string[] = [];
  for (const part of (input ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const name = permissionByName(trimmed);
    if (name) bits |= PermissionFlagsBits[name];
    else unknown.push(trimmed);
  }
  if (unknown.length > 0) {
    throw new UserError(
      `Unknown permission ${unknown.map((u) => `"${u}"`).join(", ")}. ` +
        "Separate names with commas, for example `ViewChannel, SendMessages`; the option suggests names as you type.",
    );
  }
  return bits;
}

/** The names of the permissions set in `bits`, in Discord's order. */
export function permissionNames(bits: bigint): FlagName[] {
  return PERMISSION_NAMES.filter((name) => (bits & PermissionFlagsBits[name]) !== 0n);
}

export function formatPermissions(bits: bigint): string {
  const names = permissionNames(bits);
  return names.length ? names.join(", ") : "none";
}

/**
 * Autocomplete for a comma-separated list: completes the last entry and keeps
 * the ones before it.
 */
export function suggestPermissions(input: string, limit = 25): { name: string; value: string }[] {
  const parts = input.split(",");
  const last = normalise(parts.pop() ?? "");
  const done = parts.map((p) => p.trim()).filter(Boolean);
  const taken = new Set(done.map((p) => permissionByName(p)));
  const prefix = done.length ? done.join(", ") + ", " : "";
  const matches = PERMISSION_NAMES.filter((name) => !taken.has(name) && normalise(name).includes(last));
  matches.sort((a, b) => Number(!normalise(a).startsWith(last)) - Number(!normalise(b).startsWith(last)));
  return matches
    .map((name) => prefix + name)
    .filter((value) => value.length <= 100)
    .slice(0, limit)
    .map((value) => ({ name: value, value }));
}

/** A full overwrite description for discord.js: true for allow, false for deny, null for neutral. */
export function overwriteOptions(allow: bigint, deny: bigint): Partial<Record<FlagName, boolean | null>> {
  const out: Partial<Record<FlagName, boolean | null>> = {};
  for (const name of PERMISSION_NAMES) {
    const bit = PermissionFlagsBits[name];
    out[name] = (allow & bit) !== 0n ? true : (deny & bit) !== 0n ? false : null;
  }
  return out;
}
