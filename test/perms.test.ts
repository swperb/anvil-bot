import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits as P } from "discord.js";
import { formatPermissions, overwriteOptions, parsePermissions, permissionByName, suggestPermissions } from "../src/perms.ts";
import { UserError } from "../src/errors.ts";

test("parses names ignoring case, spaces and underscores", () => {
  assert.equal(parsePermissions("view channel, SEND_MESSAGES"), P.ViewChannel | P.SendMessages);
  assert.equal(parsePermissions(""), 0n);
  assert.equal(parsePermissions(null), 0n);
});

test("accepts the names shown in Discord's settings", () => {
  assert.equal(permissionByName("Manage Permissions"), "ManageRoles");
  assert.equal(permissionByName("Manage Server"), "ManageGuild");
  assert.equal(permissionByName("Timeout Members"), "ModerateMembers");
});

test("rejects unknown names and lists them", () => {
  assert.throws(() => parsePermissions("ViewChannel, FlyToTheMoon, Nope"), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /"FlyToTheMoon", "Nope"/);
    return true;
  });
});

test("formats bits back to names without deprecated aliases", () => {
  assert.equal(formatPermissions(P.ManageGuildExpressions | P.Administrator), "Administrator, ManageGuildExpressions");
  assert.equal(formatPermissions(0n), "none");
});

test("autocomplete completes the last entry and keeps the earlier ones", () => {
  const out = suggestPermissions("ViewChannel, sendm");
  assert.equal(out[0]?.value, "ViewChannel, SendMessages");
  assert.ok(out.every((c) => c.value.startsWith("ViewChannel, ")));
  assert.ok(!out.some((c) => c.value.endsWith(", ViewChannel")));
  assert.ok(suggestPermissions("").length === 25);
});

test("overwrite options mark every flag allowed, denied or neutral", () => {
  const o = overwriteOptions(P.ViewChannel, P.SendMessages);
  assert.equal(o.ViewChannel, true);
  assert.equal(o.SendMessages, false);
  assert.equal(o.Administrator, null);
});
