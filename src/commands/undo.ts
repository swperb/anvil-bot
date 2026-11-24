import { slash, type Command } from "../command.ts";
import { UserError } from "../errors.ts";
import { describeUndo, runUndo, undoIsDestructive } from "../undo.ts";

export const undo: Command = {
  data: slash("undo", "Undo a change Anvil made").addIntegerOption((o) =>
    o.setName("id").setDescription("The change number (default: your latest change)").setMinValue(1),
  ),

  async execute(session) {
    const { journal } = session.services;
    const { actor } = session;
    const id = session.options.getInteger("id");
    const entry = id === null ? journal.latestUndoable(actor.id) : journal.get(id);
    if (!entry) throw new UserError(id === null ? "You have no changes left to undo." : `There is no change #${id}.`);
    if (entry.userId !== actor.id && !actor.isOwner) {
      throw new UserError(`Change #${entry.id} was made by <@${entry.userId}>; only they or the server owner can undo it.`);
    }
    if (entry.undoneBy !== null) throw new UserError(`Change #${entry.id} was already undone by change #${entry.undoneBy}.`);
    if (!entry.undo) throw new UserError(`Change #${entry.id} (${entry.summary}) cannot be undone.`);

    const plan = describeUndo(entry.undo);
    if (undoIsDestructive(entry.undo)) {
      if (!(await session.confirm(`Undo change #${entry.id} (${entry.summary})?\nThis will ${plan}.`, "Yes, undo it"))) return;
    }
    const result = await runUndo(session.guild, entry.undo, `Anvil: undo #${entry.id}, for ${session.member.user.tag}`);
    const record = await session.done(`Undid #${entry.id}: ${result}`, null);
    journal.markUndone(entry.id, record.id);
  },
};

export const history: Command = {
  data: slash("history", "Show Anvil's recent changes").addIntegerOption((o) =>
    o.setName("count").setDescription("How many (default 10)").setMinValue(1).setMaxValue(25),
  ),

  async execute(session) {
    const entries = session.services.journal.recent(session.options.getInteger("count") ?? 10);
    if (entries.length === 0) {
      await session.say("Anvil has not changed anything yet.");
      return;
    }
    const lines = entries.map((e) => {
      const state = e.undoneBy !== null ? ` (undone by #${e.undoneBy})` : e.undo ? "" : " (cannot be undone)";
      return `**#${e.id}** <t:${Math.floor(Date.parse(e.at) / 1000)}:R> <@${e.userId}>: ${e.summary}${state}`;
    });
    let text = "";
    for (const line of lines) {
      if (text.length + line.length + 1 > 1990) break;
      text += line + "\n";
    }
    await session.say(text);
  },
};

