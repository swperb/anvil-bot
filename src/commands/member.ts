import { requireMember, slash, type Command } from "../command.ts";
import { UserError } from "../errors.ts";

const MAX_TIMEOUT_MIN = 28 * 24 * 60;

export const member: Command = {
  data: slash("member", "Nicknames, timeouts, kicks and bans")
    .addSubcommand((s) =>
      s
        .setName("nick")
        .setDescription("Set or clear a member's nickname")
        .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true))
        .addStringOption((o) => o.setName("nickname").setDescription("New nickname; leave empty to clear").setMaxLength(32)),
    )
    .addSubcommand((s) =>
      s
        .setName("timeout")
        .setDescription("Stop a member talking for a while")
        .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("minutes").setDescription("How long (up to 28 days)").setRequired(true).setMinValue(1).setMaxValue(MAX_TIMEOUT_MIN),
        )
        .addStringOption((o) => o.setName("reason").setDescription("Why (goes in Discord's audit log)").setMaxLength(400)),
    )
    .addSubcommand((s) =>
      s
        .setName("untimeout")
        .setDescription("End a member's timeout")
        .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("kick")
        .setDescription("Remove a member; they can rejoin with an invite (asks first)")
        .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Why (goes in Discord's audit log)").setMaxLength(400)),
    )
    .addSubcommand((s) =>
      s
        .setName("ban")
        .setDescription("Ban someone, in the server or not (asks first)")
        .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("delete_hours").setDescription("Also delete their messages from the last N hours (0-168, default 0)").setMinValue(0).setMaxValue(168),
        )
        .addStringOption((o) => o.setName("reason").setDescription("Why (goes in Discord's audit log)").setMaxLength(400)),
    )
    .addSubcommand((s) =>
      s
        .setName("unban")
        .setDescription("Lift a ban")
        .addStringOption((o) => o.setName("user_id").setDescription("Their user ID (see Server Settings > Bans)").setRequired(true)),
    ),

  async execute(session) {
    const { options, guild, actor, rules } = session;
    const sub = options.getSubcommand(true);
    const why = options.getString("reason");
    const reason = `Anvil, for ${session.member.user.tag}${why ? `: ${why}` : ""}`;

    if (sub === "unban") {
      const id = options.getString("user_id", true).trim();
      if (!/^\d{17,20}$/.test(id)) throw new UserError("A user ID is 17 to 20 digits.");
      const ban = await guild.bans.fetch(id).catch(() => null);
      if (!ban) throw new UserError("That person is not banned.");
      await guild.bans.remove(id, reason);
      await session.done(`Unbanned **${ban.user.tag}** (<@${id}>)`, { kind: "ban", userId: id });
      return;
    }

    if (sub === "ban") {
      const user = options.getUser("user", true);
      const inServer = await guild.members.fetch(user.id).catch(() => null);
      if (inServer) requireMember(actor, inServer, rules);
      else if (user.id === rules.botId) throw new UserError("Anvil will not act on itself.");
      const hours = options.getInteger("delete_hours") ?? 0;
      const ok = await session.confirm(
        `Ban **${user.tag}** (<@${user.id}>)${hours ? ` and delete their messages from the last ${hours} hour(s)` : ""}?` +
          `${why ? `\nReason: ${why}` : ""}\n/undo lifts the ban${hours ? " but cannot bring the messages back" : ""}.`,
      );
      if (!ok) return;
      await guild.bans.create(user.id, { deleteMessageSeconds: hours * 3600, reason });
      await session.done(`Banned **${user.tag}** (<@${user.id}>)${why ? `: ${why}` : ""}`, { kind: "unban", userId: user.id });
      return;
    }

    const user = options.getUser("member", true);
    const target = await guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError(`${user.tag} is not in the server.`);
    requireMember(actor, target, rules);

    if (sub === "nick") {
      const nickname = options.getString("nickname");
      const before = target.nickname;
      await target.setNickname(nickname, reason);
      await session.done(
        nickname ? `Set <@${target.id}>'s nickname to "${nickname}"` : `Cleared <@${target.id}>'s nickname`,
        { kind: "setNickname", userId: target.id, nickname: before },
      );
      return;
    }

    if (sub === "timeout") {
      const minutes = options.getInteger("minutes", true);
      await target.timeout(minutes * 60_000, reason);
      await session.done(`Timed out <@${target.id}> for ${minutes} minute(s)${why ? `: ${why}` : ""}`, {
        kind: "removeTimeout",
        userId: target.id,
      });
      return;
    }

    if (sub === "untimeout") {
      if (!target.isCommunicationDisabled()) throw new UserError(`<@${target.id}> is not timed out.`);
      await target.timeout(null, reason);
      await session.done(`Ended <@${target.id}>'s timeout`, null);
      return;
    }

    if (sub === "kick") {
      const ok = await session.confirm(
        `Kick <@${target.id}> (**${target.user.tag}**)?${why ? `\nReason: ${why}` : ""}\nThis cannot be undone; they can rejoin with an invite.`,
      );
      if (!ok) return;
      await target.kick(reason);
      await session.done(`Kicked **${target.user.tag}** (<@${target.id}>)${why ? `: ${why}` : ""}`, null);
    }
  },
};
