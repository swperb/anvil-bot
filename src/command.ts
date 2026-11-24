import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Role,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { checkMemberTarget, checkRoleTarget, type Actor, type Rules } from "./auth.ts";
import { UserError } from "./errors.ts";
import type { Session } from "./session.ts";

/** One slash command. Add a file in src/commands/ that exports one of these, then list it in src/commands/index.ts. */
export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  /** Anyone in the server may run it (it must check anything sensitive itself). Default: owner and Anvil Admins only. */
  public?: boolean;
  /** Return true if this run opens a pop-up form first (the router then does not start a reply). */
  usesModal?(interaction: ChatInputCommandInteraction<"cached">): boolean;
  execute(session: Session): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<"cached">): Promise<void>;
}

/** A slash command that only appears in servers, and by default only to Administrators. */
export function slash(name: string, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export function actorOf(member: GuildMember, adminRoleId: string | null): Actor {
  return {
    id: member.id,
    isOwner: member.guild.ownerId === member.id,
    hasAdminRole: adminRoleId !== null && member.roles.cache.has(adminRoleId),
    topRolePosition: member.roles.highest.position,
    permissions: member.permissions.bitfield,
  };
}

/** Throw a UserError if `why` is a reason to refuse. */
export function refuse(why: string | null): void {
  if (why) throw new UserError(why);
}

export function requireRole(actor: Actor, role: Role, rules: Rules): void {
  refuse(
    checkRoleTarget(
      actor,
      { id: role.id, name: role.name, position: role.position, permissions: role.permissions.bitfield, managed: role.managed },
      rules,
    ),
  );
}

export function requireMember(actor: Actor, member: GuildMember, rules: Rules): void {
  refuse(
    checkMemberTarget(
      actor,
      { id: member.id, isOwner: member.guild.ownerId === member.id, topRolePosition: member.roles.highest.position },
      rules,
    ),
  );
}

/** Slash options are one line; let people write \n for a line break. */
export function unescapeLines(text: string): string {
  return text.replace(/\\n/g, "\n");
}
