// One run of one command: replying, asking for confirmation, and recording the change.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import type { Actor, Rules } from "./auth.ts";
import type { Audit } from "./audit.ts";
import type { Entry, Journal, UndoOp } from "./journal.ts";

const CONFIRM_MS = 60_000;
const firstLine = (s: string) => s.split("\n")[0] ?? s;
const MODAL_MS = 15 * 60_000;

export interface Services {
  journal: Journal;
  audit: Audit;
}

export class Session {
  readonly interaction: ChatInputCommandInteraction<"cached">;
  readonly guild: Guild;
  readonly member: GuildMember;
  readonly actor: Actor;
  readonly rules: Rules;
  readonly services: Services;
  #target: ChatInputCommandInteraction<"cached"> | ModalSubmitInteraction<"cached">;

  constructor(
    interaction: ChatInputCommandInteraction<"cached">,
    actor: Actor,
    rules: Rules,
    services: Services,
  ) {
    this.interaction = interaction;
    this.guild = interaction.guild;
    this.member = interaction.member;
    this.actor = actor;
    this.rules = rules;
    this.services = services;
    this.#target = interaction;
  }

  get options() {
    return this.interaction.options;
  }

  /** Start a private reply. Every reply from Anvil is visible only to the person who ran the command. */
  async defer(): Promise<void> {
    if (!this.#target.deferred && !this.#target.replied) {
      await this.#target.deferReply({ flags: MessageFlags.Ephemeral });
    }
  }

  /** Replace the private reply's text. Mentions in it never ping anyone. */
  async say(content: string, components: ActionRowBuilder<ButtonBuilder>[] = []) {
    await this.defer();
    return this.#target.editReply({ content, components, allowedMentions: { parse: [] } });
  }

  /**
   * Ask the person to confirm a destructive change with buttons. Only they can
   * press them; no answer within a minute counts as no.
   */
  async confirm(question: string, confirmLabel = "Yes, do it"): Promise<boolean> {
    const id = `anvil:confirm:${this.interaction.id}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${id}:yes`).setLabel(confirmLabel).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${id}:no`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    const message = await this.say(`${question}\n-# Confirm within 60 seconds.`, [row]);
    try {
      const press = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: CONFIRM_MS,
        filter: (i) => i.user.id === this.actor.id && i.customId.startsWith(id),
      });
      const yes = press.customId === `${id}:yes`;
      await press.update({ content: yes ? "Working on it..." : "Cancelled. Nothing was changed.", components: [] });
      if (!yes) await this.services.audit.note(this.guild, `<@${this.actor.id}> cancelled: ${firstLine(question)}`);
      return yes;
    } catch {
      await this.say("No answer within 60 seconds, so nothing was changed.");
      await this.services.audit.note(this.guild, `<@${this.actor.id}> did not confirm in time: ${firstLine(question)}`);
      return false;
    }
  }

  /**
   * Ask for longer text in a pop-up form (Discord's slash options are one line).
   * Must be called before anything else replies. Returns null if the form is closed.
   */
  async promptText(title: string, label: string, value = "", maxLength = 2000): Promise<string | null> {
    const id = `anvil:modal:${this.interaction.id}`;
    const input = new TextInputBuilder()
      .setCustomId("text")
      .setLabel(label.slice(0, 45))
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(maxLength)
      .setRequired(true);
    if (value) input.setValue(value.slice(0, maxLength));
    await this.interaction.showModal(
      new ModalBuilder()
        .setCustomId(id)
        .setTitle(title.slice(0, 45))
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    );
    const submit = await this.interaction
      .awaitModalSubmit({ time: MODAL_MS, filter: (i) => i.customId === id && i.user.id === this.actor.id })
      .catch(() => null);
    if (!submit || !submit.inCachedGuild()) return null;
    this.#target = submit;
    await this.defer();
    return submit.fields.getTextInputValue("text");
  }

  /** Record a finished change in the journal and the audit log, and tell the person. */
  async done(summary: string, undo: UndoOp | null, note?: string): Promise<Entry> {
    const entry = this.services.journal.record({
      userId: this.actor.id,
      userTag: this.member.user.tag,
      summary,
      undo,
    });
    await this.services.audit.change(this.guild, entry);
    const how = undo ? `Undo it with \`/undo id:${entry.id}\`.` : "This cannot be undone.";
    await this.say(`Done: ${summary}\n-# Change #${entry.id}. ${how}${note ? ` ${note}` : ""}`);
    return entry;
  }
}
