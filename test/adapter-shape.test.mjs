import test from "node:test";
import assert from "node:assert/strict";
import { LineAdapter } from "../lib/line-adapter.mjs";

test("adapter defaults to a macOS-like device profile", () => {
  const adapter = new LineAdapter({ dataDir: "/tmp/line-native-test" });
  assert.equal(adapter.device, "DESKTOPMAC");
  assert.match(adapter.storagePath, /storage\.json$/);
});

test("adapter can be configured for a desktop windows profile", () => {
  const adapter = new LineAdapter({ device: "DESKTOPWIN", version: "test" });
  assert.equal(adapter.device, "DESKTOPWIN");
  assert.equal(adapter.version, "test");
});


test("group/room chats preserve inferred MID type when raw chat shape omits type", async () => {
  const adapter = new LineAdapter({ linejsRuntime: {
    BaseClient: class {},
    Client: class {},
    FileStorage: class {},
  }});
  adapter.client = {
    base: { getToType: (mid) => mid === "g123" ? 2 : 0 },
    async fetchJoinedChats() { return [{ mid: "g123", name: "テストグループ" }]; },
    async fetchUsers() { return []; },
  };
  const chats = await adapter.chats({ includeFriends: false });
  assert.equal(chats[0].type, 2);
  assert.equal(chats[0].kind, "GROUP");
});


test("renderer does not depend on replaceWith for stable avatar roots", async () => {
  const { readFile } = await import("node:fs/promises");
  const renderer = await readFile(new URL("../gui/renderer.js", import.meta.url), "utf8");
  assert.equal(/(?:infoAvatar|headAvatar|profileOld)\.replaceWith\(/.test(renderer), false);
  assert.match(renderer, /function updateAvatar\(/);
});
