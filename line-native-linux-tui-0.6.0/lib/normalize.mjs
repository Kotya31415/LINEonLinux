/**
 * Convert LINEJS domain objects / raw values into JSON-safe data for a UI.
 * This module intentionally contains no network/auth logic.
 */

export function jsonSafe(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return { type: "bytes", length: value.length };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "function") return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const normalized = jsonSafe(v, seen);
    if (normalized !== undefined) out[k] = normalized;
  }
  return out;
}

export function normalizeProfile(profile) {
  return {
    mid: profile?.mid ?? null,
    displayName: profile?.displayName ?? profile?.display_name ?? "",
    pictureStatus: profile?.pictureStatus ?? profile?.picture_status ?? null,
    statusMessage: profile?.statusMessage ?? profile?.status_message ?? "",
    regionCode: profile?.regionCode ?? profile?.region_code ?? null,
    raw: jsonSafe(profile),
  };
}

function memberDisplayName(member) {
  return member?.displayName ?? member?.display_name ?? member?.name ?? member?.mid ?? null;
}

export function normalizeChat(chat, extra = {}) {
  const raw = chat?.raw ?? chat ?? {};
  const mid = chat?.mid ?? raw.chatMid ?? raw.chat_mid ?? raw.mid ?? null;
  const members = Array.isArray(raw.members) ? raw.members :
    (Array.isArray(raw.contacts) ? raw.contacts : []);
  const memberNames = members.map(memberDisplayName).filter(Boolean);
  let name = chat?.name ?? raw.chatName ?? raw.chat_name ?? raw.name ?? "";
  if (!name && memberNames.length) name = memberNames.slice(0, 4).join(", ");
  if (!name) name = mid ?? "(unknown)";
  return {
    mid,
    name,
    type: raw.type ?? raw.chatType ?? extra.type ?? null,
    kind: extra.kind ?? null,
    virtual: Boolean(extra.virtual),
    pictureStatus: raw.pictureStatus ?? raw.picture_status ?? null,
    lastUpdate: raw.lastUpdateTime ?? raw.last_update_time ?? null,
    notificationDisabled: raw.notificationDisabled ?? null,
    favorite: raw.favorite ?? null,
    memberCount: members.length || null,
    memberNames,
    raw: jsonSafe(raw),
  };
}

export function normalizeMessage(message, { selfMid = null, chatMid = null } = {}) {
  const raw = message?.raw ?? message ?? {};
  let text = "";
  try {
    text = typeof message?.text === "function" ? message.text() : (raw.text ?? "");
  } catch {
    text = raw.text ?? "";
  }
  let from = null;
  try {
    from = typeof message?.from === "function" ? message.from() : (raw.from_ ?? raw.from ?? null);
  } catch {
    from = raw.from_ ?? raw.from ?? null;
  }
  let to = null;
  try {
    to = typeof message?.to === "function" ? message.to() : (raw.to ?? null);
  } catch {
    to = raw.to ?? null;
  }
  let mine = false;
  try {
    mine = typeof message?.isMyMessage === "function" ? message.isMyMessage() : false;
  } catch {
    mine = false;
  }
  const resolvedChatMid = chatMid ?? (selfMid && (raw.to ?? to) === selfMid ? (raw.from_ ?? raw.from ?? from) : (raw.to ?? to));
  return {
    id: raw.id ?? raw.messageId ?? raw.message_id ?? null,
    createdTime: raw.createdTime ?? raw.created_time ?? null,
    chatMid: resolvedChatMid ?? null,
    fromMid: from,
    fromName: raw.fromName ?? raw.from_name ?? message?.fromName ?? message?.from_name ?? null,
    toMid: to,
    text,
    contentType: raw.contentType ?? raw.content_type ?? null,
    chunks: Array.isArray(raw.chunks) ? raw.chunks.length : null,
    isEdited: typeof message?.isEdited === "function" ? message.isEdited() : false,
    isMyMessage: mine,
    raw: jsonSafe(raw),
  };
}

export function displayMessage(message) {
  const n = normalizeMessage(message);
  const when = n.createdTime ? new Date(Number(n.createdTime)).toLocaleTimeString() : "--:--:--";
  const body = n.text || `[contentType=${n.contentType ?? "?"}]`;
  return `${when} ${n.isMyMessage ? "→" : "←"} ${body}`;
}
