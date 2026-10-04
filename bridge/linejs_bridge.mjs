#!/usr/bin/env node
// JSON-lines IPC adapter. Request/response messages carry requestId so multiple
// concurrent GUI requests can safely be in flight without type collisions.

import readline from "node:readline";
import { LineAdapter, showQrAnsi } from "../lib/line-adapter.mjs";

const adapter = new LineAdapter();

function emit(obj) {
  const replacer = (_key, value) => typeof value === "bigint" ? value.toString() : value;
  process.stdout.write(JSON.stringify(obj, replacer) + "\n");
}

function respond(requestId, type, payload = {}) {
  emit({ requestId, type, ...payload });
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
adapter.on("e2eeDirect", (data) => emit({ type: "e2eeDirect", ...data }));

async function handle(req) {
  const id = req.requestId ?? null;
  try {
    switch (req.method) {
      case "ping":
        respond(id, "pong");
        break;
      case "login":
        await adapter.login({ mode: req.mode ?? "auto", token: req.token ?? null });
        respond(id, "login_ok", { profile: await adapter.profile() });
        break;
      case "login_qr":
        await adapter.login({ mode: "qr" });
        respond(id, "login_ok", { profile: await adapter.profile() });
        break;
      case "login_token":
        await adapter.login({ mode: "token", token: req.token ?? null });
        respond(id, "login_ok", { profile: await adapter.profile() });
        break;
      case "session":
        respond(id, "session", { session: await adapter.restoreSession() });
        break;
      case "profile":
        respond(id, "profile", { profile: await adapter.profile() });
        break;
      case "chats":
        respond(id, "chats", { chats: await adapter.chats() });
        break;
      case "friends":
        respond(id, "friends", { friends: await adapter.friends() });
        break;
      case "history":
        respond(id, "history", {
          chatMid: req.chatMid,
          messages: await adapter.history(req.chatMid, req.limit ?? 50),
        });
        break;
      case "chat_info":
        respond(id, "chat_info", { chatMid: req.chatMid, info: await adapter.chatInfo(req.chatMid) });
        break;
      case "message_media":
        respond(id, "message_media", {
          chatMid: req.chatMid,
          messageId: req.messageId,
          media: await adapter.messageMedia(req.chatMid, req.messageId, { preview: req.preview !== false, force: req.force === true }),
        });
        break;
      case "albums":
        respond(id, "albums", { chatMid: req.chatMid, albums: await adapter.albums(req.chatMid, { force: req.force === true }) });
        break;
      case "album_photos":
        respond(id, "album_photos", {
          chatMid: req.chatMid,
          albumId: req.albumId,
          result: await adapter.albumPhotos(req.chatMid, req.albumId, { continuationToken: req.continuationToken ?? null, limit: req.limit ?? 50, force: req.force === true }),
        });
        break;
      case "album_media":
        respond(id, "album_media", {
          chatMid: req.chatMid,
          albumId: req.albumId,
          mediaId: req.mediaId,
          media: await adapter.albumMedia(req.chatMid, req.albumId, {
            id: req.mediaId,
            mediaKind: req.mediaKind,
            mime: req.mime,
            name: req.name,
            resourceOid: req.resourceOid,
            resourceSid: req.resourceSid,
          }, { preview: req.preview !== false }),
        });
        break;
      case "send_text":
        respond(id, "sent", {
          message: await adapter.sendText(req.chatMid, req.text, { e2ee: req.e2ee !== false }),
        });
        break;
      case "send_file":
        respond(id, "file_sent", {
          message: await adapter.sendFile(req.chatMid, req.filePath, { caption: req.caption ?? "" }),
        });
        break;
      case "send_sticker":
        respond(id, "sticker_sent", {
          message: await adapter.sendSticker(req.chatMid, { packageId: req.packageId, stickerId: req.stickerId, version: req.version ?? "100" }),
        });
        break;
      case "mark_read":
        respond(id, "marked_read", {
          chatMid: req.chatMid,
          changed: await adapter.markRead(req.chatMid),
        });
        break;
      case "diag":
        respond(id, "diag", { diagnostics: await adapter.exportDiagnostics() });
        break;
      case "logout":
        await adapter.logout();
        respond(id, "logout_ok");
        break;
      case "qr_ansi": {
        const ansi = await showQrAnsi(req.url);
        respond(id, "qr_ansi", { value: ansi });
        break;
      }
      default:
        throw new Error(`unknown method: ${req.method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respond(id, "error", {
      method: req.method,
      message,
      name: error?.name ?? "Error",
      code: error?.code ?? error?.cause?.code ?? null,
      cause: error?.cause?.message ?? null,
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); }
  catch (error) {
    emit({ type: "error", message: `JSON parse error: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  await handle(req);
});
