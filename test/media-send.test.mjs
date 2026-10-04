import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineAdapter, inferOutgoingMediaSpec, sortMessagesChronologically } from "../lib/line-adapter.mjs";

test("sortMessagesChronologically puts oldest messages first", () => {
  const sorted = sortMessagesChronologically([
    { id: "new", createdTime: 300 },
    { id: "old", createdTime: 100 },
    { id: "mid", createdTime: 200 },
  ]);
  assert.deepEqual(sorted.map((message) => message.id), ["old", "mid", "new"]);
});

test("inferOutgoingMediaSpec maps common attachments", () => {
  assert.deepEqual(inferOutgoingMediaSpec("photo.jpg", "image/jpeg"), { contentType: 1, mediaKind: "image", uploadType: "image" });
  assert.deepEqual(inferOutgoingMediaSpec("clip.mp4", "video/mp4"), { contentType: 2, mediaKind: "video", uploadType: "video" });
  assert.deepEqual(inferOutgoingMediaSpec("voice.m4a", "audio/mp4"), { contentType: 3, mediaKind: "audio", uploadType: "audio" });
  assert.deepEqual(inferOutgoingMediaSpec("report.pdf", "application/pdf"), { contentType: 14, mediaKind: "file", uploadType: "file" });
});

test("sendFile reserves a Talk message then uploads the object", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-media-"));
  const file = join(root, "hello.txt");
  await writeFile(file, "hello");

  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response("OK", { status: 200 });
  };

  try {
    const adapter = new LineAdapter({ device: "DESKTOPMAC", version: "3.4.2" });
    let sentOptions = null;
    adapter.client = {
      authToken: () => "test-token",
      base: {
        talk: {
          sendMessage: async (input) => {
            sentOptions = input;
            return { id: "12345", createdTime: 999 };
          },
        },
      },
    };
    adapter.selfMid = "u-self";

    const result = await adapter.sendFile("u-target", file);
    assert.equal(sentOptions.to, "u-target");
    assert.equal(sentOptions.contentType, 14);
    assert.equal(sentOptions.e2ee, false);
    assert.equal(result.id, "12345");
    assert.equal(result.mediaKind, "file");
    assert.equal(result.fileName, "hello.txt");
    assert.equal(result.fileSize, 5);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /upload\.nhn$/);
    assert.equal(calls[0].options.headers["X-Line-Access"], "test-token");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("sendSticker sends the three sticker reference fields", async () => {
  const adapter = new LineAdapter({ device: "DESKTOPMAC", version: "3.4.2" });
  let sentOptions = null;
  adapter.client = {
    base: {
      talk: {
        sendMessage: async (input) => {
          sentOptions = input;
          return { id: "sticker-1", createdTime: 1000 };
        },
      },
    },
  };
  adapter.selfMid = "u-self";
  const result = await adapter.sendSticker("u-target", { packageId: "11539", stickerId: "52114135", version: "1" });
  assert.equal(sentOptions.to, "u-target");
  assert.equal(sentOptions.contentType, 7);
  assert.deepEqual(sentOptions.contentMetadata, { STKVER: "1", STKPKGID: "11539", STKID: "52114135" });
  assert.equal(sentOptions.e2ee, false);
  assert.equal(result.mediaKind, "sticker");
});
