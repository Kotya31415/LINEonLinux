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
