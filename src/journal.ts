// The journal: every change Anvil makes, with how to undo it.
//
// It is an append-only JSON Lines file in DATA_DIR, so it survives restarts and
// can be read by hand. Each line is either a change ({"type":"change",...}) or
// a note that a change was undone ({"type":"undone",...}).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** A permission overwrite, with bitfields as decimal strings so it fits in JSON. */
export interface OverwriteSnapshot {
  id: string;
  /** 0 for a role, 1 for a member. */
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface ChannelSnapshot {
  id: string;
  name: string;
  type: number;
  topic: string | null;
  parentId: string | null;
  position: number;
  nsfw: boolean;
  rateLimitPerUser: number;
  bitrate: number | null;
  userLimit: number | null;
  overwrites: OverwriteSnapshot[];
  /** Channels inside it, when it is a category. */
  childIds: string[];
}

export interface ChannelFields {
  name?: string;
  topic?: string | null;
  parentId?: string | null;
  rateLimitPerUser?: number;
  nsfw?: boolean;
  position?: number;
}

export interface RoleFields {
  name?: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
  position?: number;
}

export interface RoleSnapshot {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  position: number;
  memberIds: string[];
  /** Overwrites for this role, by channel. */
  channelOverwrites: { channelId: string; allow: string; deny: string }[];
}

export interface GuildFields {
  name?: string;
  description?: string | null;
  verificationLevel?: number;
  defaultMessageNotifications?: number;
  systemChannelId?: string | null;
  rulesChannelId?: string | null;
  afkChannelId?: string | null;
  afkTimeout?: number;
  iconURL?: string | null;
}

/** How to reverse one change. */
export type UndoOp =
  | { kind: "deleteChannel"; channelId: string }
  | { kind: "editChannel"; channelId: string; before: ChannelFields }
  | { kind: "recreateChannel"; snapshot: ChannelSnapshot }
  | { kind: "deleteRole"; roleId: string }
  | { kind: "editRole"; roleId: string; before: RoleFields }
  | { kind: "recreateRole"; snapshot: RoleSnapshot }
  | { kind: "memberRole"; userId: string; roleId: string; add: boolean }
  | { kind: "setOverwrites"; channelId: string; overwrites: OverwriteSnapshot[] }
  | { kind: "deleteMessage"; channelId: string; messageId: string }
  | { kind: "editMessage"; channelId: string; messageId: string; content: string }
  | { kind: "pinMessage"; channelId: string; messageId: string; pin: boolean }
  | { kind: "editGuild"; before: GuildFields }
  | { kind: "removeTimeout"; userId: string }
  | { kind: "unban"; userId: string }
  | { kind: "ban"; userId: string }
  | { kind: "setNickname"; userId: string; nickname: string | null };

export interface Entry {
  id: number;
  at: string;
  userId: string;
  userTag: string;
  /** What happened, in Discord markdown. */
  summary: string;
  undo: UndoOp | null;
  undoneBy: number | null;
}

type Line =
  | ({ type: "change" } & Omit<Entry, "undoneBy">)
  | { type: "undone"; id: number; by: number };

export class Journal {
  #path: string;
  #entries = new Map<number, Entry>();
  #next = 1;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.#load();
  }

  #load(): void {
    const text = readFileSync(this.#path, "utf8");
    // A crash mid-write can leave a last line without its newline; end it so
    // the next record starts on a line of its own.
    if (text.length > 0 && !text.endsWith("\n")) appendFileSync(this.#path, "\n");
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue; // A torn last line after a crash; the rest is still good.
      }
      if (line.type === "change") {
        const { type: _type, ...entry } = line;
        this.#entries.set(entry.id, { ...entry, undoneBy: null });
        this.#next = Math.max(this.#next, entry.id + 1);
      } else if (line.type === "undone") {
        const entry = this.#entries.get(line.id);
        if (entry) entry.undoneBy = line.by;
      }
    }
  }

  #append(line: Line): void {
    appendFileSync(this.#path, JSON.stringify(line) + "\n");
  }

  record(change: { userId: string; userTag: string; summary: string; undo: UndoOp | null }): Entry {
    const entry: Entry = { id: this.#next++, at: new Date().toISOString(), ...change, undoneBy: null };
    this.#append({ type: "change", id: entry.id, at: entry.at, userId: entry.userId, userTag: entry.userTag, summary: entry.summary, undo: entry.undo });
    this.#entries.set(entry.id, entry);
    return entry;
  }

  markUndone(id: number, by: number): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.undoneBy !== null) return;
    entry.undoneBy = by;
    this.#append({ type: "undone", id, by });
  }

  get(id: number): Entry | undefined {
    return this.#entries.get(id);
  }

  /** The newest change that can still be undone, optionally only one made by `userId`. */
  latestUndoable(userId?: string): Entry | undefined {
    const all = [...this.#entries.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      const entry = all[i];
      if (entry && entry.undo && entry.undoneBy === null && (!userId || entry.userId === userId)) return entry;
    }
    return undefined;
  }

  recent(count: number): Entry[] {
    return [...this.#entries.values()].slice(-count).reverse();
  }
}
