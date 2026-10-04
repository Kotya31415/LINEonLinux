import test from "node:test";
import assert from "node:assert/strict";
import { jsonSafe, normalizeChat, normalizeMessage, normalizeProfile } from "../lib/normalize.mjs";

test("jsonSafe preserves bigint and removes functions", () => {
  const value = jsonSafe({ id: 123n, fn() {}, nested: { ok: true } });
  assert.deepEqual(value, { id: "123", nested: { ok: true } });
});

test("normalizeChat accepts domain object", () => {
  const chat = normalizeChat({ mid: "u123", name: "Alice", raw: { type: "USER", lastUpdateTime: 10 } });
  assert.equal(chat.mid, "u123");
  assert.equal(chat.name, "Alice");
  assert.equal(chat.type, "USER");
});

test("normalizeMessage uses high-level methods", () => {
  const msg = normalizeMessage({
    raw: { id: "m1", createdTime: 1700000000000, contentType: 0 },
    text: () => "hello",
    from: () => "u1",
    to: () => "u2",
    isMyMessage: () => true,
    isEdited: () => false,
  }, { selfMid: "me", });
  assert.equal(msg.id, "m1");
  assert.equal(msg.text, "hello");
  assert.equal(msg.fromMid, "u1");
  assert.equal(msg.toMid, "u2");
  assert.equal(msg.isMyMessage, true);
});

test("normalizeMessage resolves a 1:1 incoming chat to the sender when to=self", () => {
  const msg = normalizeMessage({ raw: { id: "m2", to: "me", from: "alice", createdTime: 1700000000000 }, text: () => "hi", from: () => "alice", to: () => "me" }, { selfMid: "me" });
  assert.equal(msg.chatMid, "alice");
});

test("normalizeProfile maps common fields", () => {
  const p = normalizeProfile({ mid: "u1", displayName: "Test", statusMessage: "Hi", regionCode: "JP" });
  assert.deepEqual(p.mid, "u1");
  assert.equal(p.displayName, "Test");
  assert.equal(p.statusMessage, "Hi");
  assert.equal(p.regionCode, "JP");
});

test("normalizeUser handles the real GetContactV3 profile field", async () => {
  const { normalizeUser } = await import("../lib/normalize.mjs");
  const user = normalizeUser({ raw: {
    targetUserMid: "u123",
    targetProfileDetail: { profileName: "Real LINE Name", picturePath: "p", pictureStatus: "1" },
    friendDetail: { overriddenName: "" },
  }});
  assert.equal(user.mid, "u123");
  assert.equal(user.profileName, "Real LINE Name");
  assert.equal(user.displayName, "Real LINE Name");
});

test("normalizeUser prefers LINE's local display-name override", async () => {
  const { normalizeUser } = await import("../lib/normalize.mjs");
  const user = normalizeUser({ raw: {
    targetUserMid: "u456",
    targetProfileDetail: { profileName: "Profile Name" },
    friendDetail: { overriddenName: "My Custom Name" },
  }});
  assert.equal(user.displayName, "My Custom Name");
  assert.equal(user.profileName, "Profile Name");
  assert.equal(user.overriddenName, "My Custom Name");
});

test("normalizeUser exposes avatar URL candidates from pictureStatus", async () => {
  const { normalizeUser } = await import("../lib/normalize.mjs");
  const user = normalizeUser({ raw: { targetUserMid: "u789", targetProfileDetail: { profileName: "Avatar User", pictureStatus: "abc/def" } } });
  assert.deepEqual(user.avatarUrls, [
    "https://profile.line-scdn.net/abc/def",
    "https://obs.line-scdn.net/abc/def",
    "https://dl.profile.line-cdn.net/abc/def",
  ]);
});
