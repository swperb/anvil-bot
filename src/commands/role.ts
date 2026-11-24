import { slash, refuse, requireMember, requireRole, type Command } from "../command.ts";
import { checkGrant } from "../auth.ts";
import { UserError } from "../errors.ts";
import type { RoleFields } from "../journal.ts";
import { formatPermissions, parsePermissions, suggestPermissions } from "../perms.ts";
import { snapshotRole } from "../snapshot.ts";
import { applyRoleFields } from "../undo.ts";

/** "#ff8800", "ff8800" or "none". */
export function parseColor(input: string): number {
  const s = input.trim().toLowerCase();
  if (s === "none" || s === "default") return 0;
  const m = /^#?([0-9a-f]{6})$/.exec(s);
  if (!m?.[1]) throw new UserError(`"${input}" is not a colour. Use a hex code such as #ff8800, or none.`);
  return parseInt(m[1], 16);
}

const hex = (n: number) => (n ? `#${n.toString(16).padStart(6, "0")}` : "none");

export const role: Command = {
  data: slash("role", "Create, change, delete, give or take roles")
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create a role")
        .addStringOption((o) => o.setName("name").setDescription("Its name").setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName("color").setDescription("Hex colour such as #ff8800"))
        .addStringOption((o) =>
          o.setName("permissions").setDescription("Comma-separated, e.g. ViewChannel, SendMessages (default: none)").setAutocomplete(true),
        )
        .addBooleanOption((o) => o.setName("hoist").setDescription("Show its members separately in the member list"))
        .addBooleanOption((o) => o.setName("mentionable").setDescription("Let anyone @mention it")),
    )
    .addSubcommand((s) =>
      s
        .setName("edit")
        .setDescription("Change a role")
        .addRoleOption((o) => o.setName("role").setDescription("Which one").setRequired(true))
        .addStringOption((o) => o.setName("name").setDescription("New name").setMaxLength(100))
        .addStringOption((o) => o.setName("color").setDescription("Hex colour such as #ff8800, or none"))
        .addStringOption((o) =>
          o.setName("permissions").setDescription("Replace its permissions with this list ('-' for none)").setAutocomplete(true),
        )
        .addBooleanOption((o) => o.setName("hoist").setDescription("Show its members separately in the member list"))
        .addBooleanOption((o) => o.setName("mentionable").setDescription("Let anyone @mention it"))
        .addIntegerOption((o) => o.setName("position").setDescription("Position in the role list (1 is just above @everyone)").setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName("delete")
        .setDescription("Delete a role (asks first)")
        .addRoleOption((o) => o.setName("role").setDescription("Which one").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("give")
        .setDescription("Give a member a role")
        .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true))
        .addRoleOption((o) => o.setName("role").setDescription("Which role").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("take")
        .setDescription("Take a role from a member")
        .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true))
        .addRoleOption((o) => o.setName("role").setDescription("Which role").setRequired(true)),
    ),

  async autocomplete(interaction) {
    await interaction.respond(suggestPermissions(interaction.options.getFocused()));
  },

  async execute(session) {
    const { options, guild, actor, rules } = session;
    const reason = `Anvil, for ${session.member.user.tag}`;
    const sub = options.getSubcommand(true);

    if (sub === "create") {
      const color = parseColor(options.getString("color") ?? "none");
      const permissions = parsePermissions(options.getString("permissions"));
      refuse(checkGrant(actor, permissions));
      const created = await guild.roles.create({
        name: options.getString("name", true),
        colors: { primaryColor: color },
        permissions,
        hoist: options.getBoolean("hoist") ?? false,
        mentionable: options.getBoolean("mentionable") ?? false,
        reason,
      });
      await session.done(
        `Created role <@&${created.id}> (**${created.name}**, colour ${hex(color)}, permissions: ${formatPermissions(permissions)})`,
        { kind: "deleteRole", roleId: created.id },
      );
      return;
    }

    const target = options.getRole("role", true);
    requireRole(actor, target, rules);

    if (sub === "edit") {
      const after: RoleFields = {};
      const before: RoleFields = {};
      const name = options.getString("name");
      if (name !== null) [after.name, before.name] = [name, target.name];
      const color = options.getString("color");
      if (color !== null) [after.color, before.color] = [parseColor(color), target.colors.primaryColor];
      const perms = options.getString("permissions");
      if (perms !== null) {
        const bits = perms.trim() === "-" ? 0n : parsePermissions(perms);
        refuse(checkGrant(actor, bits & ~target.permissions.bitfield));
        [after.permissions, before.permissions] = [bits.toString(), target.permissions.bitfield.toString()];
      }
      const hoist = options.getBoolean("hoist");
      if (hoist !== null) [after.hoist, before.hoist] = [hoist, target.hoist];
      const mentionable = options.getBoolean("mentionable");
      if (mentionable !== null) [after.mentionable, before.mentionable] = [mentionable, target.mentionable];
      const position = options.getInteger("position");
      if (position !== null) {
        if (!actor.isOwner && position >= actor.topRolePosition) {
          throw new UserError("You cannot move a role to or above your own highest role.");
        }
        [after.position, before.position] = [position, target.position];
      }
      if (Object.keys(after).length === 0) throw new UserError("Say what to change: give at least one option besides the role.");
      await applyRoleFields(guild, target.id, after, reason);
      const what = Object.keys(after).join(", ");
      const permNote = after.permissions !== undefined ? ` (permissions now: ${formatPermissions(BigInt(after.permissions))})` : "";
      await session.done(`Changed ${what} of <@&${target.id}>${permNote}`, { kind: "editRole", roleId: target.id, before });
      return;
    }

    if (sub === "delete") {
      if (target.id === guild.id) throw new UserError("@everyone cannot be deleted.");
      const snapshot = await snapshotRole(guild, target);
      const ok = await session.confirm(
        `Delete the role <@&${target.id}> (**${target.name}**)? ${snapshot.memberIds.length} member(s) have it.\n` +
          "/undo recreates it with the same permissions, gives it back to the same members and restores its channel permissions; it gets a new ID.",
      );
      if (!ok) return;
      await target.delete(reason);
      await session.done(`Deleted role **${target.name}** (it had ${snapshot.memberIds.length} member(s))`, {
        kind: "recreateRole",
        snapshot,
      });
      return;
    }

    // give / take
    if (target.id === guild.id) throw new UserError("Everyone has @everyone; it cannot be given or taken.");
    const user = options.getUser("member", true);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError(`${user.tag} is not in the server.`);
    requireMember(actor, member, rules);
    const give = sub === "give";
    if (give === member.roles.cache.has(target.id)) {
      throw new UserError(`<@${member.id}> ${give ? "already has" : "does not have"} <@&${target.id}>.`);
    }
    if (give) await member.roles.add(target, reason);
    else await member.roles.remove(target, reason);
    await session.done(`${give ? "Gave" : "Took"} <@&${target.id}> ${give ? "to" : "from"} <@${member.id}>`, {
      kind: "memberRole",
      userId: member.id,
      roleId: target.id,
      add: !give,
    });
  },
};
