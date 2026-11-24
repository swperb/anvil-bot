import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits as P } from "discord.js";
import { checkAuthorised, checkGrant, checkMemberTarget, checkRoleTarget, type Actor, type Rules } from "../src/auth.ts";

const rules: Rules = { adminRoleId: "900", botId: "1", botTopRolePosition: 20, logChannelId: "800" };
const owner: Actor = { id: "10", isOwner: true, hasAdminRole: false, topRolePosition: 0, permissions: 0n };
const admin: Actor = { id: "11", isOwner: false, hasAdminRole: true, topRolePosition: 10, permissions: P.ManageChannels | P.ViewChannel };
const stranger: Actor = { id: "12", isOwner: false, hasAdminRole: false, topRolePosition: 15, permissions: P.Administrator };
const role = (over: Partial<{ id: string; position: number; permissions: bigint; managed: boolean }> = {}) => ({
  id: "500", name: "Helpers", position: 5, permissions: 0n, managed: false, ...over,
});

test("only the owner and Anvil Admins may command Anvil, whatever Discord permissions others hold", () => {
  assert.equal(checkAuthorised(owner), null);
  assert.equal(checkAuthorised(admin), null);
  assert.match(checkAuthorised(stranger) ?? "", /Only the server owner/);
});

test("admins cannot touch the Anvil Admin role or Administrator roles; the owner can", () => {
  assert.match(checkRoleTarget(admin, role({ id: "900" }), rules) ?? "", /Only the server owner/);
  assert.match(checkRoleTarget(admin, role({ permissions: P.Administrator }), rules) ?? "", /Only the server owner/);
  assert.equal(checkRoleTarget(owner, role({ id: "900" }), rules), null);
});

test("admins cannot act on roles at or above their own", () => {
  assert.equal(checkRoleTarget(admin, role({ position: 9 }), rules), null);
  assert.match(checkRoleTarget(admin, role({ position: 10 }), rules) ?? "", /at or above your own/);
});

test("nobody can act on roles at or above Anvil's, or on managed roles", () => {
  assert.match(checkRoleTarget(owner, role({ position: 20 }), rules) ?? "", /above Anvil's own role/);
  assert.match(checkRoleTarget(owner, role({ managed: true }), rules) ?? "", /integration/);
});

test("only the owner grants Administrator; admins grant only what they hold", () => {
  assert.equal(checkGrant(owner, P.Administrator), null);
  assert.match(checkGrant(admin, P.Administrator) ?? "", /Only the server owner/);
  assert.equal(checkGrant(admin, P.ManageChannels), null);
  assert.match(checkGrant(admin, P.BanMembers | P.ManageChannels) ?? "", /do not have yourself: BanMembers\.$/);
  const fullAdmin = { ...admin, permissions: P.Administrator };
  assert.equal(checkGrant(fullAdmin, P.BanMembers), null);
  assert.match(checkGrant(fullAdmin, P.Administrator) ?? "", /Only the server owner/);
});

test("member targets: not Anvil, not the owner, not yourself, not your equals", () => {
  const member = (over: Partial<{ id: string; isOwner: boolean; topRolePosition: number }>) => ({ id: "50", isOwner: false, topRolePosition: 3, ...over });
  assert.match(checkMemberTarget(owner, member({ id: "1" }), rules) ?? "", /itself/);
  assert.match(checkMemberTarget(admin, member({ isOwner: true }), rules) ?? "", /Only the server owner/);
  assert.match(checkMemberTarget(admin, member({ id: "11" }), rules) ?? "", /yourself/);
  assert.match(checkMemberTarget(admin, member({ topRolePosition: 10 }), rules) ?? "", /at or above yours/);
  assert.equal(checkMemberTarget(admin, member({}), rules), null);
  assert.equal(checkMemberTarget(owner, member({ id: "10", isOwner: true }), rules), null);
});
