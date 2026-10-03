#!/usr/bin/env node

import readline from "node:readline/promises";
import process from "node:process";
import { LineAdapter, showQrAnsi } from "../lib/line-adapter.mjs";
import { displayMessage } from "../lib/normalize.mjs";

const adapter = new LineAdapter();
let currentChat = null;

function printHelp() {
  console.log(`\nCommands:
  login [auto|qr|token]   Login
  profile                 Show my profile
  chats                   List chats + personal contacts
  friends                 List friends only
  use <MID|number>        Select a chat
  history [N]             Show recent messages
  send <TEXT>             Send with E2EE
  send-plain <TEXT>       Explicit non-E2EE send for diagnosis/fallback
  chatinfo                Show chat + E2EE diagnostics
  e2ee-preflight          Probe current ROOM/GROUP key before sending
  e2ee-direct <TEXT>      Explicit direct current-key E2EE send
  read                    Mark latest message read
  watch                   Keep receiving events
  diag                    Show local diagnostics
  help                    Show this help
  quit                    Exit\n`);
}

adapter.on("status", ({ state }) => console.log(`[status] ${state}`));
adapter.on("warning", ({ message }) => console.error(`[warning] ${message}`));
adapter.on("pin", ({ pin }) => console.log(`\n[PIN] ${pin}\n`));
adapter.on("qr", async ({ url }) => {
  console.log("\n[QR] Scan this QR with LINE.\n");
  const ansi = await showQrAnsi(url);
  if (ansi) console.log(ansi);
  else console.log(`QR URL: ${url}`);
});
adapter.on("ready", ({ profile, device }) => console.log(`[ready] ${profile.displayName || profile.mid} / device=${device}`));
adapter.on("listening", () => console.log("[events] listening for Talk events"));
adapter.on("message", (message) => console.log(`\n[message] ${message.chatName} (${message.chatMid})\n${displayMessage(message)}`));
adapter.on("message:edit", (message) => console.log(`\n[edit] ${message.chatName} (${message.chatMid})\n${displayMessage(message)}`));

async function selectChat(value) {
  const number = Number(value);
  if (Number.isInteger(number) && number >= 1 && number <= adapter.chatList.length) {
    return adapter.chatList[number - 1];
  }
  const chat = await adapter.resolveChat(value);
  if (!chat) throw new Error(`chat not found: ${value}`);
  return chat;
}

async function runCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const [command, ...rest] = trimmed.split(" ");
  const arg = rest.join(" ");
  try {
    switch (command.toLowerCase()) {
      case "help": printHelp(); break;
      case "login": await adapter.login({ mode: rest[0] || "auto" }); break;
      case "profile": console.dir(await adapter.profile(), { depth: null }); break;
      case "chats": {
        const chats = await adapter.chats();
        console.log("\n #   type   name                                  MID");
        console.log("--- ------ ------------------------------------- --------------------------------");
        chats.forEach((chat, i) => {
          const type = chat.kind || (chat.type === 0 ? "USER" : chat.type === 1 ? "ROOM" : chat.type === 2 ? "GROUP" : "CHAT");
          console.log(`${String(i + 1).padStart(3)} ${String(type).padEnd(6)} ${String(chat.name).slice(0, 37).padEnd(37)} ${chat.mid}`);
        });
        break;
      }
      case "friends": {
        const users = await adapter.friends();
        users.forEach((user, i) => console.log(`${String(i + 1).padStart(3)} ${user.displayName}  ${user.mid}`));
        break;
      }
      case "use": {
        if (!rest[0]) throw new Error("usage: use <MID|number>");
        currentChat = await selectChat(rest[0]);
        console.log(`selected ${currentChat.name} (${currentChat.mid}) [${currentChat.kind ?? currentChat.type ?? "CHAT"}]`);
        break;
      }
      case "history": {
        if (!currentChat) throw new Error("select a chat first: use <MID|number>");
        const rawLimit = rest[0] ? Number(rest[0]) : 50;
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
        const messages = await adapter.history(currentChat.mid, limit);
        if (!messages.length) console.log("(no messages returned)");
        for (const message of messages) console.log(displayMessage(message));
        break;
      }
      case "chatinfo":
        if (!currentChat) throw new Error("select a chat first: use <MID|number>");
        console.dir(await adapter.chatInfo(currentChat.mid), { depth: null });
        break;
      case "e2ee-preflight":
        if (!currentChat) throw new Error("select a chat first: use <MID|number>");
        console.dir(await adapter.preflightE2EE(currentChat.mid), { depth: null });
        break;
      case "e2ee-direct": {
        if (!currentChat) throw new Error("select a chat first: use <MID|number>");
        if (!arg) throw new Error("usage: e2ee-direct <TEXT>");
        const directSent = await adapter.sendTextDirectCurrentGroupKey(currentChat.mid, arg);
        console.log(`[sent] ${directSent.id ?? "accepted"} ${directSent.text}`);
        break;
      }
      case "send": {
        if (!currentChat) throw new Error("select a chat first: use <MID|number>");
        if (!arg) throw new Error("usage: send <TEXT>");
        const sent = await adapter.sendText(currentChat.mid, arg, { e2ee: true });
        console.log(`[sent] ${sent.id ?? "accepted"} ${sent.text}`);
        break;
      }
      case "send-plain":
        if (!currentChat) throw new Error("select a chat first: use <MID|number>");
        if (!arg) throw new Error("usage: send-plain <TEXT>");
        console.warn("[warning] sending without E2EE; this is explicit and is not used as an automatic fallback");
        console.log(displayMessage(await adapter.sendPlainText(currentChat.mid, arg)));
        break;
      case "read":
        if (!currentChat) throw new Error("select a chat first: use <MID|number>");
        console.log(await adapter.markRead(currentChat.mid) ? "marked read" : "nothing to mark");
        break;
      case "watch":
        await adapter.startListening();
        console.log("watching; events will print as they arrive. Ctrl+C to exit.");
        break;
      case "diag": console.dir(await adapter.exportDiagnostics(), { depth: null }); break;
      case "quit":
      case "exit": return false;
      default: console.log(`unknown command: ${command}`); printHelp();
    }
  } catch (error) {
    console.error(`[error] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
  return true;
}

async function main() {
  console.log("LINE Native Linux CLI 0.4.1");
  console.log("Backend: @evex/linejs 3.4.2 / FileStorage / E2EE current-group-key transport + explicit plaintext diagnostic path");
  printHelp();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const shutdown = () => { rl.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  while (true) {
    const line = await rl.question("> ");
    if (!(await runCommand(line))) break;
  }
  rl.close();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
