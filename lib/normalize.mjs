function primitiveString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function jsonSafe(value, seen = new WeakSet()) {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen)).filter((item) => item !== undefined);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const normalized = jsonSafe(v, seen);
    if (normalized !== undefined) out[k] = normalized;
  }
  return out;
}

export function firstProfileName(value) {
  const raw = value?.raw ?? value ?? {};

  // linejs 3.4.x wraps LINE's GetContactV3Response as:
  // { targetUserMid, targetProfileDetail: { profileName, ... }, friendDetail: { overriddenName, ... } }
  // `profileName` is therefore the actual profile name field. `displayName`
  // is useful for high-level wrappers and test doubles, but is not the primary
  // field in the real GetContactV3 response.
  const direct = [
    value?.overriddenName, value?.overridden_name,
    raw?.friendDetail?.overriddenName, raw?.friendDetail?.overridden_name,
    value?.displayName, value?.display_name, value?.profileName, value?.profile_name, value?.name,
    value?.friendName, value?.friend_name,
    raw?.displayName, raw?.display_name, raw?.profileName, raw?.profile_name, raw?.name,
    raw?.friendName, raw?.friend_name,
    raw?.targetProfileDetail?.profileName, raw?.targetProfileDetail?.displayName,
    raw?.target_profile_detail?.profileName, raw?.target_profile_detail?.displayName,
  ];
  const hit = direct.map(primitiveString).find(Boolean);
  if (hit) return hit;

  // Keep compatibility with older/alternative wrappers without recursively
  // scanning arbitrary strings from the response.
  for (const holder of [
    raw?.contact, raw?.profile, raw?.user, raw?.member, raw?.midInfo,
    raw?.targetProfileDetail, raw?.target_profile_detail, raw?.friendDetail, raw?.friend_detail,
  ]) {
    const nested = [
      holder?.overriddenName, holder?.overridden_name,
      holder?.displayName, holder?.display_name, holder?.profileName, holder?.profile_name,
      holder?.name, holder?.friendName, holder?.friend_name,
    ].map(primitiveString).find(Boolean);
    if (nested) return nested;
  }
  return null;
}

function pictureValue(value) {
  const raw = value?.raw ?? value ?? {};
  return raw?.pictureStatus ?? raw?.picture_status ?? raw?.targetProfileDetail?.pictureStatus ??
    raw?.targetProfileDetail?.picturePath ?? raw?.target_profile_detail?.pictureStatus ??
    raw?.target_profile_detail?.picturePath ?? raw?.contact?.pictureStatus ?? null;
}

function avatarCandidates(pictureStatus) {
  const value = primitiveString(pictureStatus);
  if (!value) return [];
  if (/^https?:\/\//i.test(value)) return [value];
  const encoded = value.replace(/^\/+/, "");
  return [
    `https://profile.line-scdn.net/${encoded}`,
    `https://obs.line-scdn.net/${encoded}`,
    `https://dl.profile.line-cdn.net/${encoded}`,
  ];
}

export function normalizeProfile(profile) {
  const pictureStatus = pictureValue(profile);
  return {
    mid: profile?.mid ?? profile?.raw?.mid ?? null,
    displayName: firstProfileName(profile) ?? "",
    pictureStatus,
    avatarUrls: avatarCandidates(pictureStatus),
    statusMessage: profile?.statusMessage ?? profile?.status_message ?? profile?.raw?.statusMessage ?? "",
    regionCode: profile?.regionCode ?? profile?.region_code ?? null,
    raw: jsonSafe(profile),
  };
}

export function normalizeUser(user) {
  const raw = user?.raw ?? user ?? {};
  const mid = user?.mid ?? raw?.mid ?? raw?.targetUserMid ?? raw?.target_user_mid ?? raw?.contact?.mid ?? raw?.profile?.mid ?? null;
  const displayName = firstProfileName(user);
  const profileName = primitiveString(
    raw?.targetProfileDetail?.profileName ??
    raw?.target_profile_detail?.profileName ??
    raw?.profileName ??
    user?.profileName,
  );
  const overriddenName = primitiveString(
    raw?.friendDetail?.overriddenName ??
    raw?.friend_detail?.overriddenName ??
    raw?.overriddenName ??
    user?.overriddenName,
  );
  return {
    mid,
    displayName,
    profileName,
    overriddenName,
    pictureStatus: pictureValue(user),
    avatarUrls: avatarCandidates(pictureValue(user)),
    statusMessage: raw?.statusMessage ?? raw?.status_message ?? raw?.contact?.statusMessage ?? raw?.targetProfileDetail?.statusMessage ?? null,
    raw: jsonSafe(raw),
  };
}

function memberDisplayName(member) {
  return firstProfileName(member) ?? member?.mid ?? null;
}

export function normalizeChat(chat, extra = {}) {
  const raw = chat?.raw ?? chat ?? {};
  const mid = chat?.mid ?? raw.chatMid ?? raw.chat_mid ?? raw.mid ?? null;
  const members = Array.isArray(raw.members) ? raw.members : (Array.isArray(raw.contacts) ? raw.contacts : []);
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
    pictureStatus: pictureValue(chat),
    avatarUrls: avatarCandidates(pictureValue(chat)),
    lastUpdate: raw.lastUpdateTime ?? raw.last_update_time ?? null,
    lastMessage: raw.lastMessage ?? raw.last_message ?? null,
    notificationDisabled: raw.notificationDisabled ?? null,
    favorite: raw.favorite ?? null,
    memberCount: members.length || extra.memberCount || null,
    memberNames,
    raw: jsonSafe(raw),
  };
}

export function normalizeMessage(message, { selfMid = null, chatMid = null } = {}) {
  const raw = message?.raw ?? message ?? {};
  let text = "";
  try { text = typeof message?.text === "function" ? message.text() : (raw.text ?? ""); }
  catch { text = raw.text ?? ""; }
  let from = null;
  try { from = typeof message?.from === "function" ? message.from() : (raw.from_ ?? raw.from ?? null); }
  catch { from = raw.from_ ?? raw.from ?? null; }
  let to = null;
  try { to = typeof message?.to === "function" ? message.to() : (raw.to ?? null); }
  catch { to = raw.to ?? null; }
  let mine = false;
  try { mine = typeof message?.isMyMessage === "function" ? message.isMyMessage() : (selfMid && from === selfMid); }
  catch { mine = Boolean(selfMid && from === selfMid); }
  const fromMid = typeof from === "string" ? from : (from?.id ?? from?.mid ?? raw.from_ ?? raw.from ?? null);
  const toMid = typeof to === "string" ? to : (to?.id ?? to?.mid ?? raw.to ?? null);
  const resolvedChatMid = chatMid ?? (selfMid && toMid === selfMid ? fromMid : toMid);
  return {
    id: raw.id ?? raw.messageId ?? raw.message_id ?? null,
    createdTime: raw.createdTime ?? raw.created_time ?? null,
    chatMid: resolvedChatMid ?? null,
    fromMid,
    fromName: raw.fromName ?? raw.from_name ?? message?.fromName ?? message?.from_name ?? null,
    toMid,
    text,
    contentType: raw.contentType ?? raw.content_type ?? null,
    contentMetadata: jsonSafe(raw.contentMetadata ?? raw.content_metadata ?? {}),
    chunks: Array.isArray(raw.chunks) ? raw.chunks.length : null,
    isEdited: typeof message?.isEdited === "function" ? message.isEdited() : false,
    contentPreview: raw.contentPreview ?? raw.content_preview ?? null,
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
