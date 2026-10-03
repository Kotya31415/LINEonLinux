#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline";
import { LineAdapter, showQrAnsi } from "./line-adapter.mjs";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const CLEAR = `${CSI}2J${CSI}H`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const REVERSE = `${CSI}7m`;
const FG = {
  text: `${CSI}38;5;252m`,
  dim: `${CSI}38;5;245m`,
  accent: `${CSI}38;5;83m`,
  header: `${CSI}38;5;255m`,
  self: `${CSI}38;5;231m`,
  other: `${CSI}38;5;252m`,
  yellow: `${CSI}38;5;221m`,
  red: `${CSI}38;5;203m`,
  blue: `${CSI}38;5;117m`,
};
const BG = {
  panel: `${CSI}48;5;235m`,
  selected: `${CSI}48;5;24m`,
  selfBubble: `${CSI}48;5;23m`,
  otherBubble: `${CSI}48;5;238m`,
  input: `${CSI}48;5;237m`,
  toolbar: `${CSI}48;5;234m`,
};

function cols() { return Math.max(72, Number(process.stdout.columns) || 100); }
function rows() { return Math.max(22, Number(process.stdout.rows) || 32); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function escRow(y) { return `${CSI}${y};1H`; }
function clearLine() { return `${CSI}2K`; }
function visible(s) { return String(s ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""); }
function unicodeWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp == null) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  const wide = cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
  return wide ? 2 : 1;
}
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text ?? "")) w += unicodeWidth(ch);
  return w;
}
function sliceWidth(text, max) {
  let out = "";
  let w = 0;
  for (const ch of String(text ?? "")) {
    const cw = unicodeWidth(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out;
}
function fit(text, max, ellipsis = "…") {
  const s = String(text ?? "");
  if (displayWidth(s) <= max) return s + " ".repeat(Math.max(0, max - displayWidth(s)));
  const body = sliceWidth(s, Math.max(0, max - displayWidth(ellipsis)));
  return body + ellipsis;
}
function wrapText(text, max) {
  const input = String(text ?? "").replace(/\r\n/g, "\n");
  const rawLines = input.split("\n");
  const out = [];
  for (const raw of rawLines) {
    if (!raw) { out.push(""); continue; }
    let current = "";
    let w = 0;
    for (const ch of raw) {
      const cw = unicodeWidth(ch);
      if (w + cw > max && current) {
        out.push(current);
        current = "";
        w = 0;
      }
      current += ch;
      w += cw;
    }
    out.push(current);
  }
  return out.length ? out : [""];
}
function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatListTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : `${d.getMonth() + 1}/${d.getDate()}`;
}
function typeName(chat) { return chat?.kind ?? ({ 0: "USER", 1: "ROOM", 2: "GROUP" }[chat?.type] ?? "CHAT"); }
function avatarText(chat) {
  const name = String(chat?.name ?? "?").trim();
  if (!name) return "?";
  const chars = [...name];
  return chars.slice(0, chars[0]?.match?.(/[\u3040-\u30ff\u3400-\u9fff]/) ? 1 : 2).join("").toUpperCase();
}
function memberCount(chat) {
  if (Number.isFinite(Number(chat?.memberCount))) return Number(chat.memberCount);
  const mids = chat?.raw?.extra?.groupExtra?.memberMids;
  if (mids && typeof mids === "object") return Object.keys(mids).length;
  return null;
}
function latestMessage(messages) {
  if (!messages?.length) return null;
  return messages[messages.length - 1] ?? null;
}
function chatLastUpdate(chat, messages) {
  return Math.max(Number(chat?.lastUpdate || 0), Number(latestMessage(messages)?.createdTime || 0));
}
function previewText(messages, chat) {
  const msg = latestMessage(messages);
  if (msg) return String(msg.text || `[${msg.contentType ?? "message"}]`).replace(/\s+/g, " ");
  const candidate = chat?.lastMessage?.text ?? chat?.raw?.lastMessage?.text ?? "";
  return String(candidate || "No messages yet").replace(/\s+/g, " ");
}

export class LineTui {
  constructor(adapter = new LineAdapter()) {
    this.adapter = adapter;
    this.chats = [];
    this.messages = new Map();
    this.unread = new Map();
    this.selectedMid = null;
    this.selected = 0;
    this.focus = "sidebar";
    this.mode = "normal";
    this.input = "";
    this.searchQuery = "";
    this.scrollFromBottom = 0;
    this.status = "starting";
    this.statusDetail = "Starting…";
    this.profileName = "";
    this.qrText = "";
    this.running = false;
    this.busy = false;
    this.helpScroll = 0;
    this._stdin = null;
    this._resize = null;

    this.adapter.on("status", ({ state }) => { this.status = state; this.render(); });
    this.adapter.on("warning", ({ message }) => { this.status = "warning"; this.statusDetail = message; this.render(); });
    this.adapter.on("log", (entry) => { this.statusDetail = typeof entry === "string" ? entry : entry?.message ?? JSON.stringify(entry); this.render(); });
    this.adapter.on("pin", ({ pin }) => { this.status = "PIN"; this.statusDetail = `PIN ${pin} — confirm it in LINE`; this.render(); });
    this.adapter.on("qr", async ({ url }) => {
      this.status = "QR LOGIN";
      this.qrText = await showQrAnsi(url) || `QR URL: ${url}`;
      this.statusDetail = "Scan the QR with LINE";
      this.render();
    });
    this.adapter.on("ready", ({ profile }) => {
      this.status = "ready";
      this.profileName = profile?.displayName || profile?.mid || "LINE";
      this.qrText = "";
      this.statusDetail = `Signed in as ${this.profileName}`;
      void this.refreshChats();
    });
    this.adapter.on("message", (message) => this.acceptMessage(message));
    this.adapter.on("message:edit", (message) => this.acceptMessage(message, true));
    this.adapter.on("listening", () => { this.status = "ready"; this.statusDetail = "Receiving messages"; this.render(); });
  }

  filteredIndices() {
    const q = this.searchQuery.trim().toLocaleLowerCase();
    if (!q) return this.chats.map((_, i) => i);
    return this.chats.map((c, i) => ({ c, i })).filter(({ c }) =>
      `${c.name ?? ""} ${c.mid ?? ""} ${typeName(c)}`.toLocaleLowerCase().includes(q)
    ).map(({ i }) => i);
  }

  get currentChatIndex() {
    const filtered = this.filteredIndices();
    return filtered[this.selected] ?? null;
  }

  get currentChat() { return this.currentChatIndex == null ? null : this.chats[this.currentChatIndex]; }

  clampSelection() {
    const n = this.filteredIndices().length;
    this.selected = clamp(this.selected, 0, Math.max(0, n - 1));
  }

  acceptMessage(message, edited = false) {
    if (!message?.chatMid) return;
    const list = this.messages.get(message.chatMid) ?? [];
    if (edited && message.id != null) {
      const idx = list.findIndex(m => String(m.id) === String(message.id));
      if (idx >= 0) list[idx] = message;
      else list.push(message);
    } else {
      const duplicate = message.id != null && list.some(m => String(m.id) === String(message.id));
      if (!duplicate) list.push(message);
    }
    this.messages.set(message.chatMid, list.slice(-500));
    const idx = this.chats.findIndex(c => c.mid === message.chatMid);
    if (idx >= 0 && idx !== this.currentChatIndex && !message.isMyMessage) {
      this.unread.set(message.chatMid, (this.unread.get(message.chatMid) ?? 0) + 1);
    }
    if (idx >= 0 && idx === this.currentChatIndex) this.scrollFromBottom = 0;
    this.sortChats(message.chatMid);
    this.render();
  }

  sortChats(preferMid = null) {
    if (this.chats.length < 2) return;
    const currentMid = preferMid ?? this.currentChat?.mid ?? this.selectedMid;
    this.chats.sort((a, b) => {
      const au = chatLastUpdate(a, this.messages.get(a.mid));
      const bu = chatLastUpdate(b, this.messages.get(b.mid));
      if (au !== bu) return bu - au;
      if (a.favorite && !b.favorite) return -1;
      if (!a.favorite && b.favorite) return 1;
      return String(a.name).localeCompare(String(b.name));
    });
    if (currentMid) {
      const idx = this.chats.findIndex(c => c.mid === currentMid);
      if (idx >= 0) {
        const filtered = this.filteredIndices();
        this.selected = Math.max(0, filtered.indexOf(idx));
      }
    }
  }

  async refreshChats() {
    try {
      const oldMid = this.currentChat?.mid ?? this.selectedMid;
      this.busy = true;
      this.status = "syncing";
      this.statusDetail = "Updating chats…";
      this.render();
      this.chats = await this.adapter.chats({ includeFriends: true });
      this.sortChats(oldMid);
      const idx = this.chats.findIndex(c => c.mid === oldMid);
      const filtered = this.filteredIndices();
      const filteredIdx = idx >= 0 ? filtered.indexOf(idx) : -1;
      this.selected = filteredIdx >= 0 ? filteredIdx : 0;
      this.selectedMid = this.currentChat?.mid ?? null;
      this.status = "ready";
      this.statusDetail = `${this.chats.length} chats`;
    } catch (error) {
      this.status = "error";
      this.statusDetail = error?.message ?? String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async select(delta) {
    const count = this.filteredIndices().length;
    if (!count) return;
    this.selected = clamp(this.selected + delta, 0, count - 1);
    this.selectedMid = this.currentChat?.mid ?? null;
    this.scrollFromBottom = 0;
    if (this.currentChat) {
      this.unread.delete(this.currentChat.mid);
      if (!this.messages.has(this.currentChat.mid)) await this.loadHistory(this.currentChat);
    }
    this.render();
  }

  async openCurrent() {
    if (this.currentChat) {
      this.selectedMid = this.currentChat.mid;
      this.unread.delete(this.currentChat.mid);
      await this.loadHistory(this.currentChat);
      this.focus = "conversation";
    }
  }

  async loadHistory(chat = this.currentChat) {
    if (!chat) return;
    try {
      this.busy = true;
      this.status = "history";
      this.statusDetail = `Loading ${chat.name}…`;
      this.render();
      const history = await this.adapter.history(chat.mid, 120);
      this.messages.set(chat.mid, history);
      this.scrollFromBottom = 0;
      this.status = "ready";
      this.statusDetail = `${history.length} messages · ${chat.name}`;
    } catch (error) {
      this.status = "error";
      this.statusDetail = error?.message ?? String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async send() {
    const text = this.input.trim();
    const chat = this.currentChat;
    if (!text || !chat || this.busy) return;
    this.input = "";
    this.mode = "normal";
    this.busy = true;
    this.status = "sending";
    this.statusDetail = `Sending to ${chat.name}…`;
    this.render();
    try {
      const msg = await this.adapter.sendText(chat.mid, text, { e2ee: true });
      if (msg?.chatMid) this.acceptMessage(msg);
      this.status = "ready";
      this.statusDetail = "Sent with E2EE";
      this.scrollFromBottom = 0;
    } catch (error) {
      this.status = "error";
      this.statusDetail = error?.message ?? String(error);
      this.input = text;
      this.mode = "compose";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  moveMessageScroll(delta) {
    const msgs = this.messages.get(this.currentChat?.mid) ?? [];
    this.scrollFromBottom = clamp(this.scrollFromBottom + delta, 0, Math.max(0, msgs.length - 1));
    this.render();
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === "search") this.input = this.searchQuery;
    else if (mode !== "compose") this.input = "";
    this.render();
  }

  renderTopBar(out, w) {
    const connection = this.status === "ready" ? `${FG.accent}●${RESET} CONNECTED` : `${FG.yellow}●${RESET} ${this.status.toUpperCase()}`;
    const right = this.profileName ? `${DIM}${fit(this.profileName, Math.max(10, w - 70), "…")}${RESET}` : "";
    out.push(`${escRow(1)}${BG.toolbar}${FG.header}${BOLD}  LINE${RESET}${BG.toolbar} ${DIM}Native Linux${RESET}${BG.toolbar}${" ".repeat(Math.max(1, w - visible(`  LINE Native Linux ${connection} ${right}`).length))}${connection} ${right}${RESET}${clearLine()}`);
    const searchLabel = this.searchQuery ? `${FG.blue}⌕ ${this.searchQuery}${RESET}` : `${DIM}⌕ Search chats${RESET}`;
    const hint = `${DIM}Tab pane  / search  i compose  r refresh  ? help  q quit${RESET}`;
    const barText = `  ${searchLabel}`;
    const pad = Math.max(1, w - visible(barText).length - visible(hint).length - 2);
    out.push(`${escRow(2)}${BG.panel}${barText}${" ".repeat(pad)}${hint}  ${RESET}${clearLine()}`);
  }

  renderSidebar(out, x0, y0, width, height) {
    const filtered = this.filteredIndices();
    const focused = this.focus === "sidebar" && this.mode === "normal";
    out.push(`${escRow(y0)}${x0 === 1 ? "" : `${CSI}${x0}G`}${BG.panel}${FG.header}${BOLD}Chats${RESET}${BG.panel}${DIM}  ${filtered.length}/${this.chats.length}${RESET}${clearLine()}`);
    const usable = Math.max(2, height - 1);
    const rowsPerItem = 2;
    const visibleItems = Math.max(1, Math.floor(usable / rowsPerItem));
    const start = clamp(this.selected - Math.floor(visibleItems * 0.35), 0, Math.max(0, filtered.length - visibleItems));
    for (let slot = 0; slot < visibleItems; slot++) {
      const pos = start + slot;
      const idx = filtered[pos];
      const chat = idx == null ? null : this.chats[idx];
      const baseY = y0 + 1 + slot * rowsPerItem;
      if (!chat) {
        out.push(`${escRow(baseY)}${BG.panel}${clearLine()}`);
        out.push(`${escRow(baseY + 1)}${BG.panel}${clearLine()}`);
        continue;
      }
      const active = pos === this.selected;
      const unread = this.unread.get(chat.mid) ?? 0;
      const selectedStyle = active && focused ? `${BG.selected}${FG.header}` : `${BG.panel}${FG.text}`;
      const avatar = avatarText(chat);
      const nameW = Math.max(8, width - 15);
      const preview = previewText(this.messages.get(chat.mid), chat);
      const latest = latestMessage(this.messages.get(chat.mid));
      const time = formatListTime(chatLastUpdate(chat, this.messages.get(chat.mid)) || latest?.createdTime);
      const unreadText = unread ? `${FG.yellow}${unread > 99 ? "99+" : unread}${RESET}` : "";
      const line1 = ` ${active ? "▸" : " "} ${BOLD}${fit(avatar, 4)}${RESET} ${fit(chat.name, Math.max(8, nameW - 11))}`;
      const line2 = `   ${DIM}${fit(preview, Math.max(10, width - 13 - visible(time) - (unread ? 4 : 0)))}${RESET}${" ".repeat(Math.max(0, width - displayWidth(visible(line2Raw(preview, time, unread))) - 3))}`;
      out.push(`${escRow(baseY)}${selectedStyle}${fit(visible(line1), width)}${RESET}${clearLine()}`);
      const line2raw = `   ${preview}`;
      const previewPart = fit(line2raw, Math.max(8, width - displayWidth(time) - (unread ? 5 : 1)));
      const timePart = `${DIM}${fit(time, Math.min(8, width))}${RESET}`;
      out.push(`${escRow(baseY + 1)}${selectedStyle}${previewPart}${" ".repeat(Math.max(1, width - displayWidth(previewPart) - displayWidth(time) - (unread ? 4 : 0)))}${timePart}${unread ? ` ${BG.selfBubble}${FG.yellow}${BOLD}${unread > 99 ? "99+" : unread}${RESET}${selectedStyle}` : ""}${RESET}${clearLine()}`);
    }
    if (this.mode === "search") {
      const footer = y0 + height - 1;
      const searchText = `${FG.blue}Search:${RESET} ${this.input}_`;
      out.push(`${escRow(footer)}${BG.input}${fit(visible(searchText), width)}${RESET}${clearLine()}`);
    }
  }

  renderConversation(out, x0, y0, width, height) {
    const chat = this.currentChat;
    const focused = this.focus === "conversation" && this.mode === "normal";
    const headerName = chat ? chat.name : "Select a chat";
    const type = chat ? typeName(chat) : "";
    const members = chat ? memberCount(chat) : null;
    const subtitle = chat ? `${type}${members != null ? ` · ${members} members` : ""}` : "LINE Native Linux";
    const avatar = avatarText(chat);
    const bar = `${BG.toolbar}${FG.header}${focused ? "▌" : " "} ${BOLD}${fit(avatar, 4)}${RESET}${BG.toolbar} ${BOLD}${fit(headerName, Math.max(10, width - 32))}${RESET}  ${DIM}${fit(subtitle, Math.max(8, width - 32))}${RESET}`;
    out.push(`${escRow(y0)}${x0 === 1 ? "" : `${CSI}${x0}G`}${bar}${BG.toolbar}${" ".repeat(Math.max(1, width - displayWidth(visible(bar))) )}${RESET}${clearLine()}`);

    const bodyTop = y0 + 1;
    const composerHeight = 4;
    const bodyHeight = Math.max(4, height - 1 - composerHeight);
    const bodyBottom = bodyTop + bodyHeight - 1;
    if (this.qrText) {
      const qr = this.qrText.split(/\r?\n/).filter(Boolean);
      const yStart = bodyTop + 1;
      for (let i = 0; i < bodyHeight; i++) {
        out.push(`${escRow(bodyTop + i)}${fit(qr[i] ?? "", width)}${clearLine()}`);
      }
      return;
    }
    const msgs = this.messages.get(chat?.mid) ?? [];
    if (!chat) {
      out.push(`${escRow(bodyTop + Math.floor(bodyHeight / 2))}${FG.dim}${fit("Select a conversation from the left", width)}${RESET}${clearLine()}`);
    } else if (!msgs.length) {
      const empty = `No messages yet  ·  Enter loads history  ·  i writes a message`;
      out.push(`${escRow(bodyTop + Math.floor(bodyHeight / 2))}${FG.dim}${fit(empty, width)}${RESET}${clearLine()}`);
    } else {
      const lines = [];
      const maxBubble = clamp(Math.floor(width * 0.62), 24, 64);
      for (const m of msgs) {
        const body = String(m.text || `[${m.contentType ?? "content"}]`).replace(/\r/g, "");
        const wrapped = wrapText(body, Math.max(10, maxBubble - 4));
        const name = m.isMyMessage ? "You" : (m.fromName ?? m.fromMid ?? "User");
        const stamp = formatTime(m.createdTime);
        const bubbleWidth = clamp(Math.max(12, Math.min(maxBubble, Math.max(...wrapped.map(displayWidth)) + 4)), 12, maxBubble);
        const left = m.isMyMessage ? width - bubbleWidth - 2 : 2;
        const prefix = `${m.isMyMessage ? "  " : ` ${sliceWidth(name, 18)} `}${m.isMyMessage ? "" : ""}`;
        const top = `${m.isMyMessage ? FG.self : FG.other}${m.isMyMessage ? BG.selfBubble : BG.otherBubble}${m.isMyMessage ? "╭" : "╭"}${"─".repeat(Math.max(1, bubbleWidth - 2))}╮${RESET}`;
        lines.push({ y: 0, x: left, text: top });
        for (const line of wrapped) {
          const inner = `${m.isMyMessage ? FG.self : FG.other}${m.isMyMessage ? BG.selfBubble : BG.otherBubble}│ ${fit(line, bubbleWidth - 4)} │${RESET}`;
          lines.push({ y: 0, x: left, text: inner });
        }
        const bottom = `${m.isMyMessage ? FG.self : FG.other}${m.isMyMessage ? BG.selfBubble : BG.otherBubble}╰${"─".repeat(Math.max(1, bubbleWidth - 2))}╯${RESET}`;
        lines.push({ y: 0, x: left, text: bottom });
        lines.push({ y: 0, x: Math.max(0, left + (m.isMyMessage ? bubbleWidth - displayWidth(stamp) : 1)), text: `${DIM}${stamp}${RESET}` });
        if (!m.isMyMessage) lines.push({ y: 0, x: left + 1, text: `${DIM}${fit(name, Math.min(18, bubbleWidth - 3))}${RESET}` });
        lines.push({ y: 0, x: 0, text: "" });
      }
      const lineCount = lines.length;
      const start = clamp(lineCount - bodyHeight - this.scrollFromBottom, 0, Math.max(0, lineCount - bodyHeight));
      for (let i = 0; i < bodyHeight; i++) {
        const item = lines[start + i];
        if (!item) {
          out.push(`${escRow(bodyTop + i)}${clearLine()}`);
        } else {
          const gap = " ".repeat(Math.max(0, item.x));
          out.push(`${escRow(bodyTop + i)}${gap}${item.text}${clearLine()}`);
        }
      }
    }

    const composerY = bodyBottom + 1;
    const boxStyle = this.mode === "compose" ? `${BG.input}${FG.text}` : `${BG.toolbar}${FG.dim}`;
    const prompt = this.mode === "compose" ? `${FG.accent}›${RESET} ${this.input}_` : `${DIM}Press i or Enter to compose…${RESET}`;
    out.push(`${escRow(composerY)}${boxStyle}${fit("", width)}${RESET}${clearLine()}`);
    out.push(`${escRow(composerY + 1)}${boxStyle}  ${prompt}${" ".repeat(Math.max(0, width - 4 - displayWidth(visible(prompt))))}${RESET}${clearLine()}`);
    out.push(`${escRow(composerY + 2)}${BG.toolbar}${DIM}  E2EE send${RESET}${BG.toolbar}${" ".repeat(Math.max(1, width - 17))}${DIM}Enter send  Esc cancel  PgUp/PgDn history${RESET}${clearLine()}`);
    out.push(`${escRow(composerY + 3)}${BG.toolbar}${DIM}  ${fit(this.statusDetail, Math.max(10, width - 4))}${RESET}${clearLine()}`);
  }

  render() {
    if (!this.running) return;
    const w = cols();
    const h = rows();
    const sidebarW = clamp(Math.floor(w * 0.31), 30, 38);
    const gutter = 1;
    const mainW = w - sidebarW - gutter;
    const bodyY = 4;
    const bodyH = h - 4;
    const out = [CLEAR, HIDE_CURSOR];
    this.renderTopBar(out, w);
    out.push(`${escRow(3)}${BG.toolbar}${FG.dim}${fit("", w)}${RESET}${clearLine()}`);
    this.renderSidebar(out, 1, bodyY, sidebarW - 1, bodyH);
    for (let y = bodyY; y < h; y++) out.push(`${escRow(y)}${CSI}${sidebarW}G│`);
    this.renderConversation(out, sidebarW + 1, bodyY, mainW - 1, bodyH);

    if (this.mode === "help") {
      this.renderHelp(out, w, h);
    }
    out.push(`${CSI}${h};1H`);
    process.stdout.write(out.join(""));
  }

  renderHelp(out, w, h) {
    const boxW = Math.min(76, w - 8);
    const boxH = Math.min(20, h - 6);
    const x = Math.floor((w - boxW) / 2) + 1;
    const y = Math.floor((h - boxH) / 2) + 1;
    const lines = [
      ["Navigation", "↑/↓ or j/k", "Select chats"],
      ["", "Enter", "Open / load history"],
      ["", "Tab / ←→", "Switch pane"],
      ["", "PgUp/PgDn", "Scroll conversation"],
      ["Composer", "i / Enter", "Write message"],
      ["", "Enter", "Send E2EE message"],
      ["", "Esc", "Cancel / clear"],
      ["Search", "/", "Search chats by name or MID"],
      ["Actions", "r", "Refresh chat list"],
      ["", "q / Ctrl+C", "Quit"],
      ["", "?", "Close this help"],
    ];
    for (let i = 0; i < boxH; i++) {
      const t = i === 0 ? `╭${"─".repeat(boxW - 2)}╮` : i === boxH - 1 ? `╰${"─".repeat(boxW - 2)}╯` : `│${" ".repeat(boxW - 2)}│`;
      out.push(`${escRow(y + i)}${CSI}${x}G${BG.toolbar}${FG.header}${fit(t, boxW)}${RESET}`);
    }
    out.push(`${escRow(y + 1)}${CSI}${x + 2}G${BOLD}${FG.header}Keyboard shortcuts${RESET}`);
    lines.forEach((entry, i) => {
      if (i >= boxH - 3) return;
      const [section, key, desc] = entry;
      const text = `${section ? `${BOLD}${section}${RESET}` : "     "}  ${FG.accent}${fit(key, 13)}${RESET} ${desc}`;
      out.push(`${escRow(y + 3 + i)}${CSI}${x + 2}G${text}`);
    });
    out.push(`${escRow(y + boxH - 2)}${CSI}${x + 2}G${DIM}Press any key to close${RESET}`);
  }

  async handleKeypress(str, key = {}) {
    if (this.mode === "help") {
      if (str || key.name) { this.mode = "normal"; this.render(); }
      return;
    }
    if (key.ctrl && key.name === "c") return this.stop();

    if (this.mode === "search") {
      if (key.name === "escape") { this.searchQuery = ""; this.mode = "normal"; this.input = ""; this.clampSelection(); this.render(); return; }
      if (key.name === "return" || key.name === "enter") { this.searchQuery = this.input.trim(); this.mode = "normal"; this.input = ""; this.selected = 0; this.clampSelection(); this.render(); return; }
      if (key.name === "backspace") { this.input = this.input.slice(0, -1); this.render(); return; }
      if (!key.ctrl && !key.meta && str && !key.sequence?.includes("\x1b")) { this.input += str; this.render(); }
      return;
    }

    if (this.mode === "compose") {
      if (key.name === "escape") { this.mode = "normal"; this.input = ""; this.render(); return; }
      if (key.name === "return" || key.name === "enter") { await this.send(); return; }
      if (key.name === "backspace") { this.input = this.input.slice(0, -1); this.render(); return; }
      if (key.name === "pageup") { this.input += ""; return; }
      if (!key.ctrl && !key.meta && str && !key.sequence?.includes("\x1b")) { this.input += str; this.render(); }
      return;
    }

    if (key.name === "escape") { this.render(); return; }
    if (key.name === "question" || str === "?") { this.mode = "help"; this.render(); return; }
    if (key.name === "q" || str === "q") return this.stop();
    if (key.name === "tab") { this.focus = this.focus === "sidebar" ? "conversation" : "sidebar"; this.render(); return; }
    if (key.name === "left") { this.focus = "sidebar"; this.render(); return; }
    if (key.name === "right") { this.focus = "conversation"; this.render(); return; }
    if (key.name === "up" || str === "k") { if (this.focus === "sidebar") await this.select(-1); else this.moveMessageScroll(1); return; }
    if (key.name === "down" || str === "j") { if (this.focus === "sidebar") await this.select(1); else this.moveMessageScroll(-1); return; }
    if (key.name === "pageup") { this.moveMessageScroll(8); return; }
    if (key.name === "pagedown") { this.moveMessageScroll(-8); return; }
    if (key.name === "home") { this.scrollFromBottom = Number.MAX_SAFE_INTEGER; this.render(); return; }
    if (key.name === "end") { this.scrollFromBottom = 0; this.render(); return; }
    if (key.name === "return" || key.name === "enter") {
      if (this.focus === "sidebar") await this.openCurrent();
      else this.setMode("compose");
      return;
    }
    if (key.name === "slash" || str === "/") { this.setMode("search"); return; }
    if (key.name === "i" || str === "i") { this.setMode("compose"); return; }
    if (key.name === "r" || str === "r") { await this.refreshChats(); return; }
  }

  async start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("TUI requires a TTY");
    this.running = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);
    this._stdin = (str, key) => { void this.handleKeypress(str, key); };
    process.stdin.on("keypress", this._stdin);
    this._resize = () => this.render();
    process.stdout.on("resize", this._resize);
    process.stdout.write(CLEAR + HIDE_CURSOR);
    this.render();
    try {
      await this.adapter.login({ mode: "auto" });
    } catch (error) {
      this.status = "error";
      this.statusDetail = error?.message ?? String(error);
      this.render();
    }
    return this;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._stdin) process.stdin.off("keypress", this._stdin);
    if (this._resize) process.stdout.off("resize", this._resize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${SHOW_CURSOR}${RESET}\n`);
  }
}

// Avoid allocating a long ANSI string just for an internal width check.
function line2Raw(preview, time, unread) { return `   ${preview}${time}${unread ? unread : ""}`; }

export async function main() {
  const tui = new LineTui();
  const shutdown = () => tui.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await tui.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
