import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const FAKE = "not-a-real-token.abc.def";

test("reads the token from a file and trims the newline", () => {
  const file = join(mkdtempSync(join(tmpdir(), "anvil-config-")), "token");
  writeFileSync(file, FAKE + "\n");
  const c = loadConfig({ DISCORD_TOKEN_FILE: file, GUILD_ID: "123456789012345678" });
  assert.equal(c.token, FAKE);
  assert.equal(c.guildId, "123456789012345678");
});

test("explains a missing token or unreadable file without echoing anything secret", () => {
  assert.throws(() => loadConfig({}), /No bot token/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN_FILE: "/nonexistent/token" }), /ENOENT/);
});

test("rejects a malformed GUILD_ID and a token with spaces", () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: FAKE, GUILD_ID: "abc" }), /GUILD_ID must be a Discord ID/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "two words" }), /spaces/);
});
