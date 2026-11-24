import { PermissionFlagsBits } from "discord.js";
import { slash, type Command } from "../command.ts";

export const anvil: Command = {
  data: slash("anvil", "About Anvil").addSubcommand((s) =>
    s.setName("status").setDescription("Who can command Anvil, and who could give themselves that power"),
  ),

  async execute(session) {
    const { guild, rules } = session;
    await guild.members.fetch();
    const adminRole = rules.adminRoleId ? guild.roles.cache.get(rules.adminRoleId) : undefined;
    const admins = adminRole ? adminRole.members.filter((m) => !m.user.bot).map((m) => `<@${m.id}>`) : [];
    // Anyone with Manage Roles above the Anvil Admin role, or Administrator,
    // could give themselves that role through Discord directly.
    const risky = adminRole
      ? guild.roles.cache
          .filter(
            (r) =>
              !r.managed &&
              r.id !== adminRole.id &&
              (r.permissions.has(PermissionFlagsBits.Administrator) ||
                (r.permissions.has(PermissionFlagsBits.ManageRoles) && r.position > adminRole.position)),
          )
          .map((r) => `<@&${r.id}> (${r.members.size} member(s))`)
      : [];
    const lines = [
      `Commanded by the owner <@${guild.ownerId}> and members with ${adminRole ? `<@&${adminRole.id}>` : "the Anvil Admin role (missing; restart Anvil to recreate it)"}: ${admins.length ? admins.join(", ") : "nobody yet"}.`,
      risky.length
        ? `These roles could give themselves the Anvil Admin role through Discord, so only give them to people you trust with Anvil: ${risky.join(", ")}.`
        : "No other role can hand out the Anvil Admin role.",
      `Log channel: ${rules.logChannelId ? `<#${rules.logChannelId}>` : "missing"}. Changes recorded: ${session.services.journal.recent(1)[0]?.id ?? 0}.`,
      `Running for ${Math.floor(process.uptime() / 60)} minute(s), Node ${process.version}.`,
    ];
    await session.say(lines.join("\n"));
  },
};
