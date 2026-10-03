#!/usr/bin/env node
// JSON-lines IPC adapter for the future GTK frontend.
// Real LINE transport lives in ../lib/line-adapter.mjs so CLI and GUI share it.

import readline from "node:readline";
import { LineAdapter, showQrAnsi } from "../lib/line-adapter.mjs";

const adapter = new LineAdapter();

function emit(obj) {
  const replacer = (_key, value) => typeof value === "bigint" ? value.toString() : value;
  process.stdout.write(JSON.stringify(obj, replacer) + "\n");
}

adapter.on("status", (data) => emit({ type: "status", ...data }));
adapter.on("warning", (data) => emit({ type: "warning", ...data }));
adapter.on("qr", (data) => emit({ type: "qr", ...data }));
adapter.on("pin", (data) => emit({ type: "pin", ...data }));
adapter.on("authToken", (data) => emit({ type: "authToken", ...data }));
adapter.on("ready", (data) => emit({ type: "ready", ...data }));
adapter.on("listening", (data) => emit({ type: "listening", ...data }));
adapter.on("message", (data) => emit({ type: "message", message: data }));
adapter.on("message:edit", (data) => emit({ type: "message:edit", message: data }));

async function handle(req) {
  switch (req.method) {
    case "ping":
      emit({ type: "pong" });
      break;
    case "login":
      await adapter.login({ mode: req.mode ?? "auto", token: req.token ?? null });
      break;
    case "login_qr":
      await adapter.login({ mode: "qr" });
      break;
    case "login_token":
      await adapter.login({ mode: "token", token: req.token ?? null });
      break;
    case "profile":
      emit({ type: "profile", profile: await adapter.profile() });
      break;
    case "chats":
      emit({ type: "chats", chats: await adapter.chats() });
      break;
    case "history":
      emit({ type: "history", chatMid: req.chatMid, messages: await adapter.history(req.chatMid, req.limit ?? 50) });
      break;
    case "send_text":
      emit({ type: "sent", message: await adapter.sendText(req.chatMid, req.text, { e2ee: req.e2ee !== false }) });
      break;
    case "mark_read":
      emit({ type: "marked_read", chatMid: req.chatMid, changed: await adapter.markRead(req.chatMid) });
      break;
    case "diag":
      emit({ type: "diag", diagnostics: await adapter.exportDiagnostics() });
      break;
    case "qr_ansi": {
      const ansi = await showQrAnsi(req.url);
      emit({ type: "qr_ansi", value: ansi });
      break;
    }
    default:
      throw new Error(`unknown method: ${req.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    await handle(req);
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
