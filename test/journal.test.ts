import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../src/journal.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "anvil-journal-")), "journal.jsonl");

test("records changes with increasing IDs and finds the latest undoable one per user", () => {
  const j = new Journal(fresh());
  const a = j.record({ userId: "1", userTag: "a", summary: "made x", undo: { kind: "deleteChannel", channelId: "100" } });
  const b = j.record({ userId: "2", userTag: "b", summary: "made y", undo: { kind: "deleteRole", roleId: "200" } });
  j.record({ userId: "1", userTag: "a", summary: "kicked z", undo: null });
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.equal(j.latestUndoable("1")?.id, 1);
  assert.equal(j.latestUndoable()?.id, 2);
  j.markUndone(1, 4);
  assert.equal(j.latestUndoable("1"), undefined);
  assert.deepEqual(j.recent(2).map((e) => e.id), [3, 2]);
});

test("survives a restart, including undone marks and a torn last line", () => {
  const path = fresh();
  const j = new Journal(path);
  j.record({ userId: "1", userTag: "a", summary: "one", undo: { kind: "deleteChannel", channelId: "100" } });
  j.record({ userId: "1", userTag: "a", summary: "two", undo: { kind: "deleteChannel", channelId: "101" } });
  j.markUndone(2, 3);
  appendFileSync(path, '{"type":"change","id":9');
  const again = new Journal(path);
  assert.equal(again.get(2)?.undoneBy, 3);
  assert.equal(again.latestUndoable("1")?.id, 1);
  assert.equal(again.record({ userId: "1", userTag: "a", summary: "three", undo: null }).id, 3);
  assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 5);
  assert.equal(new Journal(path).get(3)?.summary, "three");
});

test("marking twice keeps the first undo", () => {
  const j = new Journal(fresh());
  j.record({ userId: "1", userTag: "a", summary: "one", undo: { kind: "deleteChannel", channelId: "100" } });
  j.markUndone(1, 2);
  j.markUndone(1, 5);
  assert.equal(j.get(1)?.undoneBy, 2);
});
