import test from "node:test";
import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineAdapter } from "../lib/line-adapter.mjs";
import { normalizeMessage } from "../lib/normalize.mjs";

test("normalizeMessage preserves content metadata for sticker/media detection", () => {
  const msg = normalizeMessage({
    raw: {
      id: "m-sticker",
      contentType: 7,
      contentMetadata: { STKPKGID: "1", STKID: "2" },
      from_: "u1",
      to: "u2",
    },
    text: () => "",
    from: () => "u1",
    to: () => "u2",
  });
  assert.equal(msg.contentType, 7);
  assert.deepEqual(msg.contentMetadata, { STKPKGID: "1", STKID: "2" });
});

test("messageMedia returns a sticker URL from a cached TalkMessage", async () => {
  const adapter = new LineAdapter({ linejsRuntime: {} });
  adapter.messageObjects.set("u1:m1", {
    raw: { id: "m1" },
    getStickerURL: () => "https://stickers.example/1.png",
  });
  const media = await adapter.messageMedia("u1", "m1", { preview: true });
  assert.equal(media.kind, "sticker");
  assert.equal(media.url, "https://stickers.example/1.png");
  assert.equal(media.preview, true);
  assert.equal(media.name, "sticker-m1.png");
});

test("messageMedia converts image Blob to a data URL", async () => {
  const adapter = new LineAdapter({ linejsRuntime: {} });
  adapter.messageObjects.set("u1:m2", {
    raw: { id: "m2", contentType: 1 },
    getStickerURL: () => "",
    getData: async (preview) => {
      assert.equal(preview, true);
      return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    },
  });
  const media = await adapter.messageMedia("u1", "m2", { preview: true });
  assert.equal(media.kind, "image");
  assert.equal(media.mime, "image/png");
  assert.equal(media.preview, true);
  assert.equal(media.size, 3);
  assert.equal(media.dataUrl, "data:image/png;base64,AQID");
});

test("messageMedia persists a successful preview and reuses it without a TalkMessage", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-cache-"));
  try {
    const first = new LineAdapter({ dataDir: root, linejsRuntime: {} });
    first.messageObjects.set("u1:m3", {
      raw: { id: "m3", contentType: 1 },
      getData: async () => new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }),
    });
    const one = await first.messageMedia("u1", "m3", { preview: true });
    assert.equal(one.cached, true);

    const second = new LineAdapter({ dataDir: root, linejsRuntime: {} });
    const two = await second.messageMedia("u1", "m3", { preview: true });
    assert.equal(two.cached, true);
    assert.equal(two.dataUrl, "data:image/png;base64,CQgH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("messageMedia remembers HTTP 410 as unavailable instead of retrying forever", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-gone-"));
  try {
    const first = new LineAdapter({ dataDir: root, linejsRuntime: {} });
    first.messageObjects.set("u1:m4", {
      raw: { id: "m4", contentType: 1 },
      getData: async () => { throw new Error("HTTP 410 Gone"); },
    });
    const one = await first.messageMedia("u1", "m4", { preview: true });
    assert.equal(one.unavailable, true);

    const second = new LineAdapter({ dataDir: root, linejsRuntime: {} });
    const two = await second.messageMedia("u1", "m4", { preview: true });
    assert.equal(two.unavailable, true);
    assert.equal(two.cached, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
