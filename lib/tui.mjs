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
  accent: `${CSI}38;5;114m`,
  header: `${CSI}38;5;255m`,
  self: `${CSI}38;5;231m`,
  other: `${CSI}38;5;252m`,
  yellow: `${CSI}38;5;221m`,
  red: `${CSI}38;5;203m`,
  blue: `${CSI}38;5;117m`,
  cyan: `${CSI}38;5;159m`,
};
const BG = {
  base: `${CSI}48;5;234m`,
  panel: `${CSI}48;5;235m`,
  selected: `${CSI}48;5;24m`,
  selectedSoft: `${CSI}48;5;238m`,
  selfBubble: `${CSI}48;5;23m`,
  otherBubble: `${CSI}48;5;237m`,
  input: `${CSI}48;5;236m`,
  toolbar: `${CSI}48;5;233m`,
  overlay: `${CSI}48;5;236m`,
};

function termWidth() { return Math.max(76, Number(process.stdout.columns) || 110); }
function termHeight() { return Math.max(24, Number(process.stdout.rows) || 34); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function escRow(y) { return `${CSI}${y};1H`; }
function escCol(x) { return `${CSI}${Math.max(1, x)}G`; }
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
  if (max <= 0) return "";
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
  const w = displayWidth(s);
  if (w <= max) return s + " ".repeat(Math.max(0, max - w));
  if (max <= 0) return "";
  const ew = displayWidth(ellipsis);
  return sliceWidth(s, Math.max(0, max - ew)) + ellipsis;
}
function wrapText(text, max) {
  const rawLines = String(text ?? "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const raw of rawLines) {
    if (!raw) { out.push(""); continue; }
    let cur = "";
    let w = 0;
    for (const ch of raw) {
      const cw = unicodeWidth(ch);
      if (w + cw > max && cur) { out.push(cur); cur = ""; w = 0; }
      cur += ch;
      w += cw;
    }
    out.push(cur);
  }
  return out.length ? out : [""];
}
function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDateLabel(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "TODAY";
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "YESTERDAY";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }).toUpperCase();
}
function formatListTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : `${d.getMonth() + 1}/${d.getDate()}`;
}
function typeName(chat) { return chat?.kind ?? ({ 0: "USER", 1: "ROOM", 2: "GROUP" }[chat?.type] ?? "CHAT"); }
function avatarText(chat) {
  const name = String(chat?.name ?? "?").trim();
  if (!name) return "?";
  const chars = [...name];
  const first = chars[0] ?? "?";
  const isCjk = /[\u3040-\u30ff\u3400-\u9fff]/.test(first);
  return (isCjk ? first : chars.slice(0, 2).join(" ")).toUpperCase();
}
function memberCount(chat) {
  if (Number.isFinite(Number(chat?.memberCount))) return Number(chat.memberCount);
  const mids = chat?.raw?.extra?.groupExtra?.memberMids;
  if (mids && typeof mids === "object") return Object.keys(mids).length;
  return null;
}
function latestMessage(messages) { return messages?.length ? messages[messages.length - 1] : null; }
function chatLastUpdate(chat, messages) { return Math.max(Number(chat?.lastUpdate || 0), Number(latestMessage(messages)?.createdTime || 0)); }
function previewText(messages, chat) {
  const msg = latestMessage(messages);
  if (msg) return String(msg.text || `[${msg.contentType ?? "message"}]`).replace(/\s+/g, " ");
  return String(chat?.lastMessage?.text ?? chat?.raw?.lastMessage?.text ?? "No messages yet").replace(/\s+/g, " ");
}
function keycap(key, label = key) { return `${BG.selectedSoft}${FG.header}[${key}]${RESET} ${label}`; }
function borderLine(width, left = "├", fill = "─", right = "┤") { return `${left}${fill.repeat(Math.max(0, width - 2))}${right}`; }
function panelTop(width, title, focused = false) {
  const marker = focused ? `${FG.accent}●${RESET}` : `${FG.dim}○${RESET}`;
  const inner = ` ${marker} ${BOLD}${title}${RESET} `;
  const plain = visible(inner);
  const line = `┌${"─".repeat(Math.max(0, width - 2 - displayWidth(plain)))}${inner}┐`;
  return line;
}

export class LineTui {
  constructor(adapter = new LineAdapter()) {
    this.adapter = adapter;
    this.chats = [];
    this.messages = new Map();
    this.unread = new Map();
    this.selected = 0;
    this.selectedMid = null;
    this.focus = "sidebar";
    this.mode = "normal";
    this.input = "";
    this.searchQuery = "";
    this.filter = "all";
    this.scrollFromBottom = 0;
    this.status = "starting";
    this.statusDetail = "Starting…";
    this.profileName = "";
    this.qrText = "";
    this.running = false;
    this.busy = false;
    this.modal = null;
    this._stdin = null;
    this._resize = null;

    this.adapter.on("status", ({ state }) => { this.status = state; this.render(); });
    this.adapter.on("warning", ({ message }) => { this.status = "warning"; this.statusDetail = message; this.render(); });
    this.adapter.on("log", (entry) => { this.statusDetail = typeof entry === "string" ? entry : entry?.message ?? JSON.stringify(entry); this.render(); });
    this.adapter.on("pin", ({ pin }) => { this.status = "PIN"; this.statusDetail = `PIN ${pin} · confirm it in LINE`; this.render(); });
    this.adapter.on("qr", async ({ url }) => {
      this.status = "QR LOGIN";
      this.qrText = await showQrAnsi(url) || `QR URL: ${url}`;
      this.statusDetail = "Scan QR with LINE";
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
    this.adapter.on("listening", () => { this.status = "ready"; this.statusDetail = "Live · receiving messages"; this.render(); });
  }

  filteredIndices() {
    const q = this.searchQuery.trim().toLocaleLowerCase();
    let entries = this.chats.map((c, i) => ({ c, i }));
    if (this.filter === "unread") entries = entries.filter(({ c }) => (this.unread.get(c.mid) ?? 0) > 0);
    if (this.filter === "favorites") entries = entries.filter(({ c }) => Boolean(c.favorite));
    if (q) entries = entries.filter(({ c }) => `${c.name ?? ""} ${c.mid ?? ""} ${typeName(c)}`.toLocaleLowerCase().includes(q));
    return entries.map(({ i }) => i);
  }

  get currentChatIndex() { return this.filteredIndices()[this.selected] ?? null; }
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
    } else if (!(message.id != null && list.some(m => String(m.id) === String(message.id)))) {
      list.push(message);
    }
    this.messages.set(message.chatMid, list.slice(-800));
    const idx = this.chats.findIndex(c => c.mid === message.chatMid);
    if (idx >= 0 && this.chats[idx].lastUpdate !== message.createdTime) this.chats[idx].lastUpdate = Math.max(Number(this.chats[idx].lastUpdate || 0), Number(message.createdTime || 0));
    if (idx >= 0 && this.chats[idx].mid !== this.currentChat?.mid && !message.isMyMessage) this.unread.set(message.chatMid, (this.unread.get(message.chatMid) ?? 0) + 1);
    if (idx >= 0 && this.chats[idx].mid === this.currentChat?.mid) this.scrollFromBottom = 0;
    this.sortChats(message.chatMid);
    this.render();
  }

  sortChats(preferMid = null) {
    if (this.chats.length < 2) return;
    const keepMid = preferMid ?? this.currentChat?.mid ?? this.selectedMid;
    this.chats.sort((a, b) => {
      const au = chatLastUpdate(a, this.messages.get(a.mid));
      const bu = chatLastUpdate(b, this.messages.get(b.mid));
      if (au !== bu) return bu - au;
      if (a.favorite && !b.favorite) return -1;
      if (!a.favorite && b.favorite) return 1;
      return String(a.name).localeCompare(String(b.name));
    });
    if (keepMid) {
      const idx = this.chats.findIndex(c => c.mid === keepMid);
      const filtered = this.filteredIndices();
      if (idx >= 0) {
        const next = filtered.indexOf(idx);
        if (next >= 0) this.selected = next;
      }
    }
  }

  async refreshChats() {
    try {
      const oldMid = this.currentChat?.mid ?? this.selectedMid;
      this.busy = true; this.status = "syncing"; this.statusDetail = "Syncing conversations…"; this.render();
      this.chats = await this.adapter.chats({ includeFriends: true });
      this.sortChats(oldMid);
      const idx = this.chats.findIndex(c => c.mid === oldMid);
      const filtered = this.filteredIndices();
      this.selected = idx >= 0 && filtered.includes(idx) ? filtered.indexOf(idx) : 0;
      this.selectedMid = this.currentChat?.mid ?? oldMid ?? null;
      this.status = "ready"; this.statusDetail = `${this.chats.length} conversations`;
    } catch (error) {
      this.status = "error"; this.statusDetail = error?.message ?? String(error);
    } finally { this.busy = false; this.render(); }
  }

  async select(delta) {
    const count = this.filteredIndices().length;
    if (!count) return;
    this.selected = clamp(this.selected + delta, 0, count - 1);
    this.selectedMid = this.currentChat?.mid ?? null;
    this.scrollFromBottom = 0;
    if (this.currentChat && !this.messages.has(this.currentChat.mid)) await this.loadHistory(this.currentChat);
    if (this.currentChat) this.unread.delete(this.currentChat.mid);
    this.render();
  }

  async openCurrent() {
    if (!this.currentChat) return;
    this.selectedMid = this.currentChat.mid;
    this.unread.delete(this.currentChat.mid);
    await this.loadHistory(this.currentChat);
    this.focus = "conversation";
  }

  async loadHistory(chat = this.currentChat) {
    if (!chat) return;
    try {
      this.busy = true; this.status = "history"; this.statusDetail = `Loading ${chat.name}…`; this.render();
      const history = await this.adapter.history(chat.mid, 160);
      this.messages.set(chat.mid, history);
      this.scrollFromBottom = 0;
      this.status = "ready"; this.statusDetail = `${history.length} messages · ${chat.name}`;
    } catch (error) { this.status = "error"; this.statusDetail = error?.message ?? String(error); }
    finally { this.busy = false; this.render(); }
  }

  async send() {
    const text = this.input.trim();
    const chat = this.currentChat;
    if (!text || !chat || this.busy) return;
    this.input = ""; this.mode = "normal"; this.busy = true; this.status = "sending"; this.statusDetail = `Sending to ${chat.name}…`; this.render();
    try {
      const msg = await this.adapter.sendText(chat.mid, text, { e2ee: true });
      if (msg?.chatMid) this.acceptMessage(msg);
      this.status = "ready"; this.statusDetail = "Sent · E2EE"; this.scrollFromBottom = 0;
    } catch (error) { this.status = "error"; this.statusDetail = error?.message ?? String(error); this.input = text; this.mode = "compose"; }
    finally { this.busy = false; this.render(); }
  }

  moveMessageScroll(delta) {
    const msgs = this.messages.get(this.currentChat?.mid) ?? [];
    this.scrollFromBottom = clamp(this.scrollFromBottom + delta, 0, Math.max(0, msgs.length - 1));
    this.render();
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === "search") this.input = this.searchQuery;
    else if (mode === "compose") this.input = "";
    else this.input = "";
    this.render();
  }

  openModal(name) { this.modal = name; this.mode = "modal"; this.render(); }
  closeModal() { this.modal = null; this.mode = "normal"; this.render(); }

  renderTopBar(out, w) {
    const stateIcon = this.status === "ready" ? `${FG.accent}●${RESET}` : this.status === "error" ? `${FG.red}●${RESET}` : `${FG.yellow}●${RESET}`;
    const left = ` ${FG.header}${BOLD}LINE${RESET} ${DIM}Native Linux${RESET}`;
    const right = `${stateIcon} ${this.status.toUpperCase()}   ${this.profileName ? `${FG.header}${fit(this.profileName, 20)}${RESET}` : ""} `;
    out.push(`${escRow(1)}${BG.toolbar}${left}${" ".repeat(Math.max(1, w - displayWidth(visible(left)) - displayWidth(visible(right))))}${right}${RESET}${clearLine()}`);
    const search = this.mode === "search" ? `${FG.cyan}⌕ ${this.input}_` : (this.searchQuery ? `${FG.cyan}⌕ ${this.searchQuery}` : `${DIM}⌕ Search chats${RESET}`);
    const e2ee = `${FG.accent}▣${RESET} E2EE`;
    const hint = `${DIM}Ctrl+K commands  / search  ? help${RESET}`;
    const left2 = ` ${search}`;
    const right2 = `${e2ee}   ${hint}  `;
    out.push(`${escRow(2)}${BG.toolbar}${left2}${" ".repeat(Math.max(1, w - displayWidth(visible(left2)) - displayWidth(visible(right2))))}${right2}${RESET}${clearLine()}`);
    out.push(`${escRow(3)}${BG.toolbar}${DIM}${fit("", w)}${RESET}${clearLine()}`);
  }

  renderSidebar(out, x, y, width, height) {
    const focused = this.focus === "sidebar" && this.mode === "normal";
    const filtered = this.filteredIndices();
    out.push(`${escRow(y)}${escCol(x)}${BG.panel}${FG.header}${panelTop(width, `Chats  ${filtered.length}/${this.chats.length}`, focused)}${RESET}`);
    const tabs = [
      ["1", "ALL", this.filter === "all"],
      ["2", "UNREAD", this.filter === "unread"],
      ["3", "FAV", this.filter === "favorites"],
    ];
    const tabText = tabs.map(([k, label, on]) => on ? `${BG.selected}${FG.header} ${k} ${label} ${RESET}` : `${DIM} ${k} ${label} ${RESET}`).join("");
    out.push(`${escRow(y + 1)}${escCol(x)}${BG.panel}${fit(visible(tabText), width)}${RESET}`);
    const listTop = y + 2;
    const rows = Math.max(3, height - 4);
    const start = clamp(this.selected - Math.floor(rows * 0.35), 0, Math.max(0, filtered.length - rows));
    for (let slot = 0; slot < rows; slot++) {
      const pos = start + slot;
      const idx = filtered[pos];
      const chat = idx == null ? null : this.chats[idx];
      const yy = listTop + slot;
      if (!chat) { out.push(`${escRow(yy)}${escCol(x)}${BG.panel}${fit("", width)}${RESET}`); continue; }
      const active = pos === this.selected;
      const unread = this.unread.get(chat.mid) ?? 0;
      const base = active && focused ? BG.selected : BG.panel;
      const icon = avatarText(chat).slice(0, 2);
      const time = formatListTime(chatLastUpdate(chat, this.messages.get(chat.mid)));
      const count = unread ? `${FG.yellow}${BOLD}${unread > 99 ? "99+" : unread}${RESET}` : "";
      const leftName = ` ${active ? `${FG.accent}▸${RESET}` : " "} ${BG.selectedSoft}${FG.header}${icon}${RESET} ${BOLD}${fit(chat.name, Math.max(10, width - 17))}${RESET}`;
      const right = `${DIM}${time}${RESET}`;
      let line = `${leftName}${" ".repeat(Math.max(1, width - displayWidth(visible(leftName)) - displayWidth(visible(right)) - displayWidth(visible(count)) - 1))}${right}${count ? ` ${count}` : ""}`;
      out.push(`${escRow(yy)}${escCol(x)}${base}${fit(visible(line), width)}${RESET}`);
    }
    const bottom = y + height - 2;
    out.push(`${escRow(bottom)}${escCol(x)}${BG.panel}${DIM}${fit("  Enter open   r refresh", width)}${RESET}`);
    out.push(`${escRow(bottom + 1)}${escCol(x)}${BG.panel}${DIM}${fit(`  ${this.chats.length} chats`, width)}${RESET}`);
  }

  renderConversation(out, x, y, width, height) {
    const chat = this.currentChat;
    const focused = this.focus === "conversation" && this.mode === "normal";
    const title = chat ? chat.name : "Select a chat";
    const members = chat ? memberCount(chat) : null;
    const subtitle = chat ? `${typeName(chat)}${members != null ? ` · ${members} members` : ""}` : "LINE Native Linux";
    const headerH = 3;
    out.push(`${escRow(y)}${escCol(x)}${BG.panel}${FG.header}${panelTop(width, `${title}${subtitle ? `  ${DIM}${subtitle}${RESET}` : ""}`, focused)}${RESET}`);
    out.push(`${escRow(y + 1)}${escCol(x)}${BG.panel}${DIM}${fit(chat ? ` ${typeName(chat)}   ${chat.mid}` : "", width)}${RESET}`);
    out.push(`${escRow(y + 2)}${escCol(x)}${BG.panel}${DIM}${borderLine(width)}${RESET}`);

    const composerH = this.mode === "compose" ? 4 : 3;
    const bodyTop = y + headerH;
    const bodyH = Math.max(4, height - headerH - composerH);

    if (this.qrText) {
      const qr = this.qrText.split(/\r?\n/).filter(Boolean);
      const start = bodyTop + Math.max(0, Math.floor((bodyH - qr.length) / 2));
      for (let i = 0; i < bodyH; i++) {
        const content = qr[i - Math.max(0, Math.floor((bodyH - qr.length) / 2))] ?? "";
        out.push(`${escRow(bodyTop + i)}${escCol(x)}${BG.panel}${fit(content, width)}${RESET}`);
      }
      return;
    }

    const msgs = this.messages.get(chat?.mid) ?? [];
    if (!chat) {
      const mid = bodyTop + Math.floor(bodyH / 2);
      const text = "← Select a conversation from the left";
      out.push(`${escRow(mid)}${escCol(x)}${BG.panel}${FG.dim}${fit(text, width)}${RESET}`);
    } else if (!msgs.length) {
      const mid = bodyTop + Math.floor(bodyH / 2);
      const text = "No messages yet · Enter to reload history · i to compose";
      out.push(`${escRow(mid)}${escCol(x)}${BG.panel}${FG.dim}${fit(text, width)}${RESET}`);
    } else {
      const lines = [];
      const maxBubble = clamp(Math.floor(width * 0.64), 28, 72);
      let lastDate = null;
      for (const m of msgs) {
        const dateLabel = formatDateLabel(m.createdTime);
        if (dateLabel && dateLabel !== lastDate) {
          lines.push({ kind: "date", text: `── ${dateLabel} ──` });
          lastDate = dateLabel;
        }
        const body = String(m.text || `[${m.contentType ?? "content"}]`);
        const wrapped = wrapText(body, Math.max(12, maxBubble - 4));
        const name = m.isMyMessage ? "You" : (m.fromName ?? m.fromMid ?? "User");
        const stamp = formatTime(m.createdTime);
        const bubbleW = clamp(Math.max(15, Math.min(maxBubble, Math.max(...wrapped.map(displayWidth)) + 4)), 15, maxBubble);
        lines.push({ kind: "msg", m, wrapped, name, stamp, bubbleW });
      }
      const start = clamp(lines.length - bodyH - this.scrollFromBottom, 0, Math.max(0, lines.length - bodyH));
      for (let i = 0; i < bodyH; i++) {
        const item = lines[start + i];
        const yy = bodyTop + i;
        if (!item) { out.push(`${escRow(yy)}${escCol(x)}${BG.panel}${clearLine()}`); continue; }
        if (item.kind === "date") {
          const label = `${FG.dim}${item.text}${RESET}`;
          const left = Math.max(0, Math.floor((width - displayWidth(item.text)) / 2));
          out.push(`${escRow(yy)}${escCol(x)}${BG.panel}${" ".repeat(left)}${label}${" ".repeat(Math.max(0, width - left - displayWidth(item.text)))}${RESET}`);
          continue;
        }
        const { m, wrapped, name, stamp, bubbleW } = item;
        const left = m.isMyMessage ? width - bubbleW - 2 : 2;
        const bubbleBg = m.isMyMessage ? BG.selfBubble : BG.otherBubble;
        const bubbleFg = m.isMyMessage ? FG.self : FG.other;
        const label = !m.isMyMessage ? `${FG.dim}${fit(name, Math.max(8, bubbleW - 4))}${RESET}` : "";
        const firstY = yy;
        if (firstY >= bodyTop && firstY < bodyTop + bodyH) {
          out.push(`${escRow(firstY)}${escCol(x + left)}${bubbleFg}${bubbleBg}${label}${RESET}${" ".repeat(Math.max(0, bubbleW - displayWidth(visible(label))))}`.slice(0, 0));
        }
        // Build the message block into rows and only draw rows that fall in the viewport.
        const block = [];
        if (!m.isMyMessage) block.push(`${bubbleBg}${bubbleFg}╭${"─".repeat(Math.max(1, bubbleW - 2))}╮${RESET}`);
        else block.push(`${bubbleBg}${bubbleFg}╭${"─".repeat(Math.max(1, bubbleW - 2))}╮${RESET}`);
        if (!m.isMyMessage) {
          block.push(`${bubbleBg}${bubbleFg}│ ${fit(name, bubbleW - 4)} │${RESET}`);
        }
        for (const line of wrapped) block.push(`${bubbleBg}${bubbleFg}│ ${fit(line, bubbleW - 4)} │${RESET}`);
        block.push(`${bubbleBg}${bubbleFg}╰${"─".repeat(Math.max(1, bubbleW - 2))}╯${RESET}`);
        const timeLine = `${DIM}${stamp}${RESET}`;
        block.push(timeLine);
        // The current rendered item occupies multiple terminal rows, so overwrite the viewport using a lightweight canvas pass.
        // Store on an ephemeral buffer for this frame.
        item.block = block;
        item.x = left;
      }
      // Re-render message canvas cleanly to avoid partial block rows from the loop above.
      const canvas = Array.from({ length: bodyH }, () => "");
      // Recompute only the visible slice with row offsets.
      for (const filler of canvas.keys()) canvas[filler] = "";
      let rowCursor = 0;
      for (let i = start; i < lines.length && rowCursor < bodyH; i++) {
        const item = lines[i];
        if (item.kind === "date") {
          const txt = item.text;
          const left = Math.max(0, Math.floor((width - displayWidth(txt)) / 2));
          canvas[rowCursor++] = `${" ".repeat(left)}${FG.dim}${txt}${RESET}`;
          continue;
        }
        const { m, wrapped, name, stamp, bubbleW } = item;
        const left = m.isMyMessage ? width - bubbleW - 2 : 2;
        const bg = m.isMyMessage ? BG.selfBubble : BG.otherBubble;
        const fg = m.isMyMessage ? FG.self : FG.other;
        const block = [`${fg}${bg}╭${"─".repeat(Math.max(1, bubbleW - 2))}╮${RESET}`];
        if (!m.isMyMessage) block.push(`${fg}${bg}│ ${fit(name, bubbleW - 4)} │${RESET}`);
        for (const line of wrapped) block.push(`${fg}${bg}│ ${fit(line, bubbleW - 4)} │${RESET}`);
        block.push(`${fg}${bg}╰${"─".repeat(Math.max(1, bubbleW - 2))}╯${RESET}`);
        block.push(`${m.isMyMessage ? " ".repeat(Math.max(0, left + bubbleW - displayWidth(stamp) - 2)) : " ".repeat(left + 1)}${DIM}${stamp}${RESET}`);
        for (const b of block) {
          if (rowCursor >= bodyH) break;
          canvas[rowCursor++] = `${" ".repeat(left)}${b}`;
        }
        if (rowCursor < bodyH) rowCursor++;
      }
      for (let i = 0; i < bodyH; i++) out.push(`${escRow(bodyTop + i)}${escCol(x)}${BG.panel}${fit(canvas[i] ?? "", width)}${RESET}`);
    }

    const composerY = y + height - composerH;
    if (this.mode === "compose") {
      out.push(`${escRow(composerY)}${escCol(x)}${BG.input}${FG.dim}╭${"─".repeat(Math.max(0, width - 2))}╮${RESET}`);
      const msg = `${FG.header}›${RESET} ${this.input}_`;
      out.push(`${escRow(composerY + 1)}${escCol(x)}${BG.input}${fit(visible(msg), width)}${RESET}`);
      const tools = ` ${FG.dim}[+] Attach${RESET}    ${FG.dim}[E2EE]${RESET} ${FG.accent}secured${RESET}`;
      out.push(`${escRow(composerY + 2)}${escCol(x)}${BG.input}${fit(visible(tools), width)}${RESET}`);
      out.push(`${escRow(composerY + 3)}${escCol(x)}${BG.input}${FG.dim}  Enter send   Esc cancel${RESET}${" ".repeat(Math.max(0, width - displayWidth(visible("  Enter send   Esc cancel"))))}${RESET}`);
    } else {
      const prompt = chat ? `  ${DIM}i / Enter to compose…${RESET}` : `  ${DIM}Select a conversation${RESET}`;
      out.push(`${escRow(composerY)}${escCol(x)}${BG.toolbar}${fit(visible(prompt), width)}${RESET}`);
      out.push(`${escRow(composerY + 1)}${escCol(x)}${BG.toolbar}${DIM}${fit(`  ${this.statusDetail}`, width)}${RESET}`);
      out.push(`${escRow(composerY + 2)}${escCol(x)}${BG.toolbar}${this.footerHints(width)}${RESET}`);
    }
  }

  footerHints(width) {
    const hints = [keycap("↑↓", "select"), keycap("Enter", "open"), keycap("i", "compose"), keycap("/", "search"), keycap("r", "refresh"), keycap("?", "help"), keycap("q", "quit")];
    return fit(`  ${hints.join("  ")}`, width);
  }

  renderModal(out, w, h) {
    const boxW = Math.min(82, w - 8);
    const boxH = this.modal === "help" ? Math.min(20, h - 6) : Math.min(16, h - 8);
    const x = Math.floor((w - boxW) / 2) + 1;
    const y = Math.floor((h - boxH) / 2) + 1;
    const lines = this.modal === "help" ? [
      ["Navigation", "↑ ↓ / j k", "select conversation"],
      ["", "Enter", "open conversation / load history"],
      ["", "Tab / ← →", "switch pane"],
      ["", "PgUp/PgDn", "scroll messages"],
      ["Composer", "i / Enter", "compose message"],
      ["", "Enter", "send E2EE message"],
      ["Search", "/", "search conversations"],
      ["Actions", "1 2 3", "all / unread / favorites"],
      ["", "r", "refresh conversations"],
      ["", "Ctrl+K", "command palette"],
      ["", "q / Ctrl+C", "quit"],
    ] : [
      ["Chat", "name", this.currentChat?.name ?? ""],
      ["Type", "mode", this.currentChat ? typeName(this.currentChat) : ""],
      ["Members", "count", this.currentChat ? String(memberCount(this.currentChat) ?? "unknown") : ""],
      ["MID", "id", this.currentChat?.mid ?? ""],
      ["Unread", "count", this.currentChat ? String(this.unread.get(this.currentChat.mid) ?? 0) : "0"],
    ];
    for (let i = 0; i < boxH; i++) {
      const line = i === 0 ? `╭${"─".repeat(boxW - 2)}╮` : i === boxH - 1 ? `╰${"─".repeat(boxW - 2)}╯` : `│${" ".repeat(boxW - 2)}│`;
      out.push(`${escRow(y + i)}${escCol(x)}${BG.overlay}${FG.header}${line}${RESET}`);
    }
    out.push(`${escRow(y + 1)}${escCol(x + 2)}${BG.overlay}${BOLD}${FG.header}${this.modal === "help" ? "Keyboard shortcuts" : "Conversation details"}${RESET}`);
    lines.slice(0, boxH - 4).forEach(([section, key, desc], i) => {
      const yy = y + 3 + i;
      const left = section ? `${BOLD}${section}${RESET}` : "     ";
      const text = `${left}  ${FG.accent}${fit(key, 15)}${RESET} ${fit(desc, boxW - 24)}`;
      out.push(`${escRow(yy)}${escCol(x + 2)}${BG.overlay}${text}${RESET}`);
    });
    out.push(`${escRow(y + boxH - 2)}${escCol(x + 2)}${BG.overlay}${DIM}Esc / any key to close${RESET}`);
  }

  renderCommandPalette(out, w, h) {
    const boxW = Math.min(72, w - 10);
    const boxH = 10;
    const x = Math.floor((w - boxW) / 2) + 1;
    const y = Math.floor((h - boxH) / 2) + 1;
    const items = [
      ["Open chat", "Enter", "open selected chat"],
      ["Compose", "i", "write a message"],
      ["Search chats", "/", "filter conversations"],
      ["Refresh", "r", "sync conversation list"],
      ["Chat details", "d", "show selected chat info"],
      ["Help", "?", "keyboard shortcuts"],
    ];
    for (let i = 0; i < boxH; i++) {
      const line = i === 0 ? `╭${"─".repeat(boxW - 2)}╮` : i === boxH - 1 ? `╰${"─".repeat(boxW - 2)}╯` : `│${" ".repeat(boxW - 2)}│`;
      out.push(`${escRow(y + i)}${escCol(x)}${BG.overlay}${FG.header}${line}${RESET}`);
    }
    out.push(`${escRow(y + 1)}${escCol(x + 2)}${BG.overlay}${BOLD}Command palette${RESET}`);
    items.forEach(([label, key, desc], i) => out.push(`${escRow(y + 2 + i)}${escCol(x + 2)}${BG.overlay}${FG.header}${fit(label, 20)}${RESET} ${FG.accent}${fit(key, 9)}${RESET} ${DIM}${desc}${RESET}`));
  }

  render() {
    if (!this.running) return;
    const w = termWidth();
    const h = termHeight();
    const sidebarW = clamp(Math.floor(w * 0.30), 28, 38);
    const mainX = sidebarW + 2;
    const mainW = w - mainX;
    const topY = 4;
    const contentH = h - topY - 1;
    const out = [CLEAR, HIDE_CURSOR];
    out.push(`${BG.base}`);
    this.renderTopBar(out, w);
    this.renderSidebar(out, 1, topY, sidebarW, contentH);
    this.renderConversation(out, mainX, topY, mainW, contentH);
    if (this.modal) this.renderModal(out, w, h);
    else if (this.mode === "palette") this.renderCommandPalette(out, w, h);
    out.push(`${CSI}${h};1H${RESET}${SHOW_CURSOR}`);
    process.stdout.write(out.join(""));
  }

  async handleKeypress(str, key = {}) {
    if (this.modal) {
      this.closeModal();
      return;
    }
    if (this.mode === "palette") {
      if (key.name === "escape") { this.mode = "normal"; this.render(); return; }
      if (key.name === "return" || key.name === "enter") { this.mode = "normal"; this.openCurrent(); return; }
      if (key.name === "i") { this.mode = "compose"; this.input = ""; this.render(); return; }
      if (key.name === "r") { this.mode = "normal"; await this.refreshChats(); return; }
      if (key.name === "slash" || str === "/") { this.mode = "search"; this.input = this.searchQuery; this.render(); return; }
      if (key.name === "d" || str === "d") { this.mode = "normal"; this.openModal("details"); return; }
      if (key.name === "question" || str === "?") { this.mode = "normal"; this.openModal("help"); return; }
      return;
    }
    if (key.ctrl && key.name === "c") return this.stop();
    if (key.ctrl && key.name === "k") { this.mode = "palette"; this.render(); return; }
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
      if (!key.ctrl && !key.meta && str && !key.sequence?.includes("\x1b")) { this.input += str; this.render(); }
      return;
    }
    if (key.name === "escape") { this.render(); return; }
    if (key.name === "question" || str === "?") { this.openModal("help"); return; }
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
    if (key.name === "return" || key.name === "enter") { if (this.focus === "sidebar") await this.openCurrent(); else this.setMode("compose"); return; }
    if (key.name === "slash" || str === "/") { this.setMode("search"); return; }
    if (key.name === "i" || str === "i") { this.setMode("compose"); return; }
    if (key.name === "r" || str === "r") { await this.refreshChats(); return; }
    if (key.name === "1" || str === "1") { this.filter = "all"; this.selected = 0; this.clampSelection(); this.render(); return; }
    if (key.name === "2" || str === "2") { this.filter = "unread"; this.selected = 0; this.clampSelection(); this.render(); return; }
    if (key.name === "3" || str === "3") { this.filter = "favorites"; this.selected = 0; this.clampSelection(); this.render(); return; }
    if (key.name === "d" || str === "d") { this.openModal("details"); return; }
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
    try { await this.adapter.login({ mode: "auto" }); }
    catch (error) { this.status = "error"; this.statusDetail = error?.message ?? String(error); this.render(); }
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
