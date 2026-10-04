import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("album renderer performs progressive eager loading and keeps click as viewer action", async () => {
  const source = await readFile(new URL("../gui/renderer.js", import.meta.url), "utf8");
  assert.match(source, /async function preloadAlbumMedia\(epoch\)/);
  assert.match(source, /loadAlbumPhotoMedia\(photo, \{ render: false \}\)/);
  assert.match(source, /renderAlbumPhotos\(\{ schedule: false \}\)/);
  assert.match(source, /tile\.onclick = async \(\) =>/);
  assert.match(source, /state\.albumMediaLoading/);
});
