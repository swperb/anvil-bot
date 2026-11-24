// The audit log: every change, refusal and cancelled destructive action goes to
// Anvil's log file and to the private #anvil-log channel.

import { EmbedBuilder, type Guild } from "discord.js";
import type { Entry } from "./journal.ts";
import { log } from "./log.ts";

const GREEN = 0x3ba55d;
const AMBER = 0xfaa61a;
const GREY = 0x747f8d;

export class Audit {
  #channelId: () => string | null;

  constructor(channelId: () => string | null) {
    this.#channelId = channelId;
  }

  async #post(guild: Guild, embed: EmbedBuilder): Promise<void> {
    const id = this.#channelId();
    const channel = id ? guild.channels.cache.get(id) : undefined;
    if (!channel?.isTextBased()) {
      log.warn("The log channel is missing; the entry is only in anvil.log. Restart Anvil to recreate it.");
      return;
    }
    try {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
      log.error("Could not post to the log channel", err);
    }
  }

  async change(guild: Guild, entry: Entry): Promise<void> {
    log.info(`change #${entry.id} by ${entry.userTag} (${entry.userId}): ${entry.summary}`);
    await this.#post(
      guild,
      new EmbedBuilder()
        .setColor(GREEN)
        .setDescription(`**#${entry.id}** ${entry.summary}`)
        .addFields(
          { name: "By", value: `<@${entry.userId}>`, inline: true },
          { name: "Undo", value: entry.undo ? `\`/undo id:${entry.id}\`` : "Not possible", inline: true },
        )
        .setTimestamp(new Date(entry.at)),
    );
  }

  async refused(guild: Guild, userId: string, userTag: string, command: string, reason: string): Promise<void> {
    log.warn(`refused ${command} for ${userTag} (${userId}): ${reason}`);
    await this.#post(
      guild,
      new EmbedBuilder()
        .setColor(AMBER)
        .setDescription(`Refused \`${command}\` for <@${userId}>: ${reason}`)
        .setTimestamp(),
    );
  }

  async note(guild: Guild, text: string): Promise<void> {
    log.info(text);
    await this.#post(guild, new EmbedBuilder().setColor(GREY).setDescription(text).setTimestamp());
  }
}
