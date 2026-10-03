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
