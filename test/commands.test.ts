import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits as P } from "discord.js";
import { COMMANDS } from "../src/commands/index.ts";
import { parseMessageLink } from "../src/commands/message.ts";
import { mergeOverwrite } from "../src/commands/perm.ts";
import { parseColor } from "../src/commands/role.ts";

test("every command builds valid JSON, is guild-only, and only public ones are visible to everyone", () => {
  const names = new Set<string>();
  for (const command of COMMANDS) {
    const json = command.data.toJSON();
    assert.ok(!names.has(json.name), `duplicate ${json.name}`);
    names.add(json.name);
    if (command.public) assert.equal(json.default_member_permissions ?? null, null);
    else assert.equal(json.default_member_permissions, P.Administrator.toString());
    assert.deepEqual(json.contexts, [0]);
    assert.ok((json.options?.length ?? 0) <= 25);
  }
  assert.equal(names.size, 12);
  assert.deepEqual(COMMANDS.filter((c) => c.public).map((c) => c.data.name), ["bug", "bounty"]);
});

test("parses message links from every Discord host", () => {
  assert.deepEqual(parseMessageLink("https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"), {
    guildId: "111111111111111111", channelId: "222222222222222222", messageId: "333333333333333333",
  });
  assert.equal(parseMessageLink("https://ptb.discord.com/channels/1/2/3").messageId, "3");
  assert.throws(() => parseMessageLink("https://example.com/channels/1/2/3"), /not a message link/);
});

test("merging an overwrite: allow and deny move bits, reset makes them neutral", () => {
  const current = { allow: P.ViewChannel, deny: P.SendMessages };
  assert.deepEqual(mergeOverwrite(current, { allow: P.SendMessages, deny: 0n, reset: 0n }), { allow: P.ViewChannel | P.SendMessages, deny: 0n });
  assert.deepEqual(mergeOverwrite(current, { allow: 0n, deny: P.ViewChannel, reset: 0n }), { allow: 0n, deny: P.ViewChannel | P.SendMessages });
  assert.deepEqual(mergeOverwrite(current, { allow: 0n, deny: 0n, reset: P.ViewChannel | P.SendMessages }), { allow: 0n, deny: 0n });
});

test("parses role colours", () => {
  assert.equal(parseColor("#ff8800"), 0xff8800);
  assert.equal(parseColor("FF8800"), 0xff8800);
  assert.equal(parseColor("none"), 0);
  assert.throws(() => parseColor("orange"), /not a colour/);
});
