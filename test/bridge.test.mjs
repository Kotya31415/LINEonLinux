import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

function startBridge() {
  const child = spawn(process.execPath, [join(process.cwd(), "bridge/linejs_bridge.mjs")], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  return child;
}

function nextJson(child, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("bridge output timeout")); }, timeout);
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      cleanup();
      resolve(JSON.parse(line));
    };
    const onExit = (code) => { cleanup(); reject(new Error(`bridge exited ${code}`)); };
    function cleanup() {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("exit", onExit);
    }
    child.stdout.on("data", onData); child.once("exit", onExit);
  });
}

test("bridge echoes requestId for independent requests", async () => {
  const child = startBridge();
  try {
    child.stdin.write(JSON.stringify({requestId:"a", method:"ping"}) + "\n");
    child.stdin.write(JSON.stringify({requestId:"b", method:"ping"}) + "\n");
    const first = await nextJson(child);
    const second = await nextJson(child);
    assert.deepEqual(new Set([first.requestId, second.requestId]), new Set(["a", "b"]));
    assert.equal(first.type, "pong");
    assert.equal(second.type, "pong");
  } finally {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
});
