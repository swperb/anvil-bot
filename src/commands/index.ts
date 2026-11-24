import type { Command } from "../command.ts";
import { anvil } from "./anvil.ts";
import { channel } from "./channel.ts";
import { member } from "./member.ts";
import { message } from "./message.ts";
import { perm } from "./perm.ts";
import { role } from "./role.ts";
import { server } from "./server.ts";
import { history, undo } from "./undo.ts";

/** Every command Anvil registers. Add new ones here. */
export const COMMANDS: readonly Command[] = [channel, role, perm, message, server, member, undo, history, anvil];
