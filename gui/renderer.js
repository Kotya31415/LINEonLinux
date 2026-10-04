const $ = (id) => document.getElementById(id);

const PREF_KEY = "line-native-gui-preferences-v1";
const defaultPrefs = { favorites: [], aliases: {}, density: "comfortable", enterSend: true };

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return {
      favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
      aliases: raw.aliases && typeof raw.aliases === "object" ? raw.aliases : {},
      density: raw.density === "compact" ? "compact" : "comfortable",
      enterSend: raw.enterSend !== false,
    };
  } catch {
    return { ...defaultPrefs };
  }
}

const prefs = loadPrefs();

function savePrefs() {
  localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
}

const state = {
  chats: [],
  friends: [],
  active: null,
  profile: null,
  filter: "all",
  view: "messages",
  unread: new Map(),
  history: new Map(),
  pendingMessages: new Map(),
  loadingChats: false,
  loadingFriends: false,
  chatInfo: new Map(),
  media: new Map(),
  mediaLoading: new Set(),
  attachment: null,
  recentStickers: [],
  selectedSticker: null,
  albums: [],
  activeAlbum: null,
  albumPhotos: [],
  albumContinuation: null,
  albumLoading: false,
  albumMedia: new Map(),
  albumMediaLoading: new Set(),
  albumMediaFailed: new Map(),
  albumAutoEpoch: 0,
  authenticated: false,
  restoringSession: false,
};

function showToast(message, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden", "error");
  if (error) el.classList.add("error");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.add("hidden"), 3600);
}

function entityMid(entity) {
  return String(entity?.mid ?? "").trim();
}

function isFavorite(entity) {
  const mid = entityMid(entity);
  return Boolean(mid && (prefs.favorites.includes(mid) || entity?.favorite));
}

function baseName(entity) {
  const name = String(entity?.name ?? entity?.displayName ?? "").trim();
  const mid = entityMid(entity);
  return name && name !== mid ? name : "";
}

function displayName(entity) {
  const mid = entityMid(entity);
  if (mid && prefs.aliases[mid]) return prefs.aliases[mid];
  const name = baseName(entity);
  if (name) return name;
  return entity?.kind === "USER" || Number(entity?.type) === 0 ? "名前未取得" : "トーク";
}

function nameSource(entity) {
  const mid = entityMid(entity);
  if (mid && prefs.aliases[mid]) return "この端末の表示名";
  if (baseName(entity)) return "LINEプロフィール / チャット情報";
  return "未取得（MIDのみ）";
}

function initials(value) {
  const chars = [...String(value || "?").replace(/^名前未取得$/, "?")];
  return chars.slice(0, 2).join("") || "?";
}

function avatarCandidates(entity) {
  const urls = Array.isArray(entity?.avatarUrls) ? entity.avatarUrls.filter(Boolean) : [];
  if (urls.length) return urls;
  const status = String(entity?.pictureStatus ?? entity?.raw?.pictureStatus ?? entity?.raw?.picture_status ?? "").trim();
  if (!status) return [];
  if (/^https?:\/\//i.test(status)) return [status];
  const path = status.replace(/^\/+/, "");
  return [`https://profile.line-scdn.net/${path}`, `https://obs.line-scdn.net/${path}`, `https://dl.profile.line-cdn.net/${path}`];
}

function makeAvatar(entity, className = "avatar", alt = "") {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = initials(displayName(entity));
  const urls = avatarCandidates(entity);
  if (!urls.length) return el;
  const img = document.createElement("img");
  img.alt = alt || displayName(entity);
  img.loading = "lazy";
  img.decoding = "async";
  img.src = urls[0];
  let index = 0;
  img.onerror = () => {
    index += 1;
    if (index < urls.length) { img.src = urls[index]; return; }
    el.replaceChildren(document.createTextNode(initials(displayName(entity))));
  };
  el.replaceChildren(img);
  return el;
}

// Never replace the avatar root node itself. Keeping the stable DOM node is
// important because async login/chat-info requests may complete after the UI
// has switched views. Older code used Element.replaceWith() here and could
// throw when another asynchronous update had already replaced/removed the
// node, which surfaced as "Cannot read properties of null (reading replaceWith)".
function updateAvatar(id, entity, className = "avatar", alt = "") {
  const target = $(id);
  if (!target) return false;
  const avatar = makeAvatar(entity, className, alt || displayName(entity));
  target.className = avatar.className;
  target.replaceChildren(...avatar.childNodes);
  target.setAttribute("aria-label", alt || displayName(entity));
  return true;
}

function makeSmallAvatar(entity, className = "mini-avatar") {
  return makeAvatar(entity, className, displayName(entity));
}

function typeName(chat) {
  if (chat?.kind) return chat.kind;
  return ({ 0: "USER", 1: "ROOM", 2: "GROUP", 3: "SQUARE" })[Number(chat?.type)] || "TALK";
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

function formatDay(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

function messageTime(message) {
  const value = Number(message?.createdTime ?? message?.created_time ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function sortMessagesChronologically(messages) {
  return [...(Array.isArray(messages) ? messages : [])].sort((a, b) => {
    const diff = messageTime(a) - messageTime(b);
    if (diff) return diff;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

function sortHistoryInPlace(chatMid) {
  const list = state.history.get(chatMid);
  if (!Array.isArray(list)) return list;
  list.sort((a, b) => {
    const diff = messageTime(a) - messageTime(b);
    if (diff) return diff;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
  return list;
}

function lastMessage(chat) {
  const list = state.history.get(entityMid(chat));
  return list?.at(-1) || null;
}

function lastActivity(chat) {
  return Number(lastMessage(chat)?.createdTime ?? chat?.lastUpdate ?? 0) || 0;
}

function lastMessagePreview(chat) {
  const last = lastMessage(chat);
  if (last) {
    const prefix = last.isMyMessage ? "あなた: " : (typeName(chat) === "GROUP" || typeName(chat) === "ROOM" ? `${last.fromName || "相手"}: ` : "");
    const kind = messageKind(last);
    const body = last.text || (kind === "image" ? "📷 写真" : kind === "video" ? "🎬 動画" : kind === "audio" ? "🎵 音声" : kind === "sticker" ? "🙂 スタンプ" : kind === "file" ? `📎 ${last.fileName || "ファイル"}` : `[${last.contentType || "メッセージ"}]`);
    return `${prefix}${body}`;
  }
  const raw = chat?.raw?.lastMessage ?? chat?.raw?.last_message;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return raw.text || `[${raw.contentType || "メッセージ"}]`;
  return chat?.memberCount ? `${chat.memberCount}人のトーク` : "会話を開く";
}

function filteredChats() {
  const query = $("search").value.trim().toLocaleLowerCase();
  return [...state.chats]
    .filter((chat) => {
      const name = displayName(chat).toLocaleLowerCase();
      const mid = entityMid(chat).toLocaleLowerCase();
      if (query && !`${name} ${mid}`.includes(query)) return false;
      if (state.filter === "unread" && !(state.unread.get(entityMid(chat)) > 0)) return false;
      if (state.filter === "favorite" && !isFavorite(chat)) return false;
      return true;
    })
    .sort((a, b) => {
      const fav = Number(isFavorite(b)) - Number(isFavorite(a));
      if (state.filter !== "favorite" && fav) return fav;
      return lastActivity(b) - lastActivity(a);
    });
}

function syncChatPrefs(chat) {
  if (!chat?.mid) return chat;
  chat.favorite = isFavorite(chat);
  return chat;
}

function renderChats() {
  const box = $("chats");
  box.textContent = "";
  const shown = filteredChats();
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.chats.length ? "条件に一致するトークがありません" : "トークがありません";
    box.append(empty);
    $("chatCount").textContent = state.chats.length ? `${state.chats.length}件` : "";
    return;
  }

  for (const chat of shown) {
    syncChatPrefs(chat);
    const row = document.createElement("div");
    row.className = `chatitem${state.active?.mid === chat.mid ? " active" : ""}`;
    row.tabIndex = 0;

    const avatar = makeAvatar(chat, "avatar", displayName(chat));

    const text = document.createElement("div");
    text.className = "chattext";

    const line = document.createElement("div");
    line.className = "chatline";
    const name = document.createElement("strong");
    name.textContent = displayName(chat);
    const time = document.createElement("time");
    time.textContent = formatTime(lastMessage(chat)?.createdTime ?? chat.lastUpdate);
    line.append(name, time);

    const preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = lastMessagePreview(chat);
    text.append(line, preview);

    const unread = state.unread.get(chat.mid) || 0;
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      text.append(badge);
    }

    row.append(avatar, text);
    if (isFavorite(chat)) {
      const star = document.createElement("span");
      star.className = "star";
      star.textContent = "★";
      row.append(star);
    }
    const open = () => selectChat(chat);
    row.onclick = open;
    row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } };
    box.append(row);
  }
  $("chatCount").textContent = `${state.chats.length}件`;
}

function filteredFriends() {
  const query = $("search").value.trim().toLocaleLowerCase();
  return [...state.friends].filter((friend) => {
    const name = displayName(friend).toLocaleLowerCase();
    const mid = entityMid(friend).toLocaleLowerCase();
    return !query || `${name} ${mid}`.includes(query);
  }).sort((a, b) => displayName(a).localeCompare(displayName(b), "ja"));
}

function renderFriends() {
  const box = $("friends");
  box.textContent = "";
  const shown = filteredFriends();
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = `<div class="empty-icon">◎</div><span>${state.friends.length ? "条件に一致する友だちがありません" : "友だちはまだ読み込まれていません"}</span>`;
    box.append(empty);
    $("chatCount").textContent = state.friends.length ? `${state.friends.length}人` : "";
    return;
  }
  for (const friend of shown) {
    const row = document.createElement("div");
    row.className = "frienditem";
    const avatar = makeAvatar(friend, "avatar", displayName(friend));
    const main = document.createElement("div");
    main.className = "friendtext";
    const strong = document.createElement("strong");
    strong.textContent = displayName(friend);
    const sub = document.createElement("span");
    sub.textContent = friend.statusMessage || "友だち";
    main.append(strong, sub);
    const star = document.createElement("button");
    star.className = "mini-action";
    star.textContent = isFavorite(friend) ? "★" : "☆";
    star.title = isFavorite(friend) ? "お気に入りから外す" : "お気に入りに追加";
    star.onclick = (event) => { event.stopPropagation(); toggleFavoriteMid(friend.mid); renderFriends(); renderChats(); };
    row.append(avatar, main, star);
    row.onclick = () => openFriend(friend);
    box.append(row);
  }
  $("chatCount").textContent = `${state.friends.length}人`;
}

function setView(view) {
  state.view = view;
  const labels = { messages: "メッセージ", friends: "友だち", favorites: "お気に入り", settings: "設定" };
  $("sidebarTitle").textContent = labels[view] || "メッセージ";
  document.querySelectorAll(".railbtn[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("chatFilters").classList.toggle("hidden", view !== "messages" && view !== "favorites");
  $("chats").classList.toggle("hidden", view === "friends");
  $("friends").classList.toggle("hidden", view !== "friends");
  $("refresh").classList.toggle("hidden", view === "settings");
  $("search").placeholder = view === "friends" ? "友だちを検索  Ctrl+K" : "トークを検索  Ctrl+K";

  if (view === "messages") {
    $("welcome").classList.add("hidden");
    $("friendsHome").classList.add("hidden");
    $("settingsHome").classList.add("hidden");
    if (state.active) $("chatview").classList.remove("hidden"); else $("chatview").classList.add("hidden");
    renderChats();
  } else if (view === "favorites") {
    $("welcome").classList.add("hidden");
    $("friendsHome").classList.add("hidden");
    $("settingsHome").classList.add("hidden");
    $("chatview").classList.add("hidden");
    renderChats();
  } else if (view === "friends") {
    $("welcome").classList.add("hidden");
    $("settingsHome").classList.add("hidden");
    $("chatview").classList.add("hidden");
    $("friendsHome").classList.remove("hidden");
    renderFriends();
    if (!state.friends.length) loadFriends(true);
  } else {
    $("welcome").classList.add("hidden");
    $("friendsHome").classList.add("hidden");
    $("chatview").classList.add("hidden");
    $("settingsHome").classList.remove("hidden");
    $("settingsPanel").classList.remove("hidden");
  }
}

function ensureActiveVisible() {
  if (state.view === "messages") return;
  if (state.active) setView("messages");
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("statusDot").className = `dot ${kind}`.trim();
}

function updateCharCount() {
  const text = $("message").value;
  $("charcount").textContent = `${text.length} / 5000`;
  $("sendbtn").disabled = (!text.trim() && !state.attachment) || !state.active;
}

function mimeFromFilename(name) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  return ({
    jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",bmp:"image/bmp",
    mp4:"video/mp4",m4v:"video/mp4",mov:"video/quicktime",webm:"video/webm",mkv:"video/x-matroska",
    mp3:"audio/mpeg",m4a:"audio/mp4",aac:"audio/aac",wav:"audio/wav",ogg:"audio/ogg",opus:"audio/opus",flac:"audio/flac",
    pdf:"application/pdf",txt:"text/plain",zip:"application/zip","7z":"application/x-7z-compressed",tar:"application/x-tar",gz:"application/gzip",
  })[ext] || "application/octet-stream";
}

function renderAttachmentPreview() {
  const box = $("attachmentPreview");
  box.textContent = "";
  if (!state.attachment) { box.classList.add("hidden"); updateCharCount(); return; }
  box.classList.remove("hidden");
  const icon = document.createElement("span"); icon.className = "attachment-icon"; icon.textContent = state.attachment.mime.startsWith("image/") ? "▧" : "📎";
  const main = document.createElement("div"); main.className = "attachment-main";
  const name = document.createElement("strong"); name.textContent = state.attachment.name;
  const size = document.createElement("small"); size.textContent = state.attachment.size ? formatBytes(state.attachment.size) : "添付ファイル";
  main.append(name, size);
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "attachment-remove"; remove.textContent = "×"; remove.title = "添付を外す";
  remove.onclick = () => { state.attachment = null; renderAttachmentPreview(); showToast("添付を外しました"); };
  box.append(icon, main, remove);
  updateCharCount();
}

async function pickAttachment() {
  if (!state.active) return;
  try {
    const result = await window.lineNative.pickFile();
    if (!result || result.canceled || !result.filePath) return;
    state.attachment = {
      path: result.filePath,
      name: result.fileName || result.filePath.split(/[\\/]/).pop() || "attachment",
      size: Number(result.size || 0) || 0,
      mime: mimeFromFilename(result.fileName || result.filePath),
    };
    renderAttachmentPreview();
  } catch (error) {
    showToast(`ファイル選択: ${error.message}`, true);
  }
}

function autoResize() {
  const input = $("message");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function nearBottom() {
  const box = $("messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

function messageText(message) {
  return message?.text || `[${message?.contentType || "メッセージ"}]`;
}

function mediaKey(message) {
  return `${message?.chatMid || state.active?.mid || ""}:${String(message?.id ?? "")}`;
}

function messageKind(message) {
  const explicit = String(message?.mediaKind || "").toLowerCase();
  if (explicit) return explicit;
  const type = String(message?.contentType ?? "").toUpperCase();
  const meta = message?.contentMetadata || {};
  if (type === "STICKER" || Number(message?.contentType) === 7 || meta.STKPKGID || meta.STKID || meta.stickerId || meta.sticker_id) return "sticker";
  if (type === "IMAGE" || Number(message?.contentType) === 1) return "image";
  if (type === "VIDEO" || Number(message?.contentType) === 2) return "video";
  if (type === "AUDIO" || Number(message?.contentType) === 3) return "audio";
  if (type === "FILE" || Number(message?.contentType) === 14 || Number(message?.contentType) === 4) return "file";
  return null;
}

function stickerMetadata(message) {
  const meta = message?.contentMetadata && typeof message.contentMetadata === "object" ? message.contentMetadata : {};
  const packageId = meta.STKPKGID ?? meta.stkPkgId ?? meta.stickerPackageId ?? meta.sticker_package_id ?? null;
  const stickerId = meta.STKID ?? meta.stkId ?? meta.stickerId ?? meta.sticker_id ?? null;
  const version = meta.STKVER ?? meta.stkVer ?? meta.stickerVersion ?? meta.sticker_version ?? "100";
  if (packageId == null || stickerId == null) return null;
  return { packageId: String(packageId), stickerId: String(stickerId), version: String(version || "100"), previewUrl: message?.stickerUrl || null };
}

function rememberSticker(message) {
  const sticker = stickerMetadata(message);
  if (!sticker) return;
  const key = `${sticker.packageId}:${sticker.stickerId}:${sticker.version}`;
  const existing = state.recentStickers.find((item) => item.key === key);
  const entry = { ...sticker, key };
  if (existing) Object.assign(existing, entry);
  else state.recentStickers.unshift(entry);
  state.recentStickers = state.recentStickers.slice(0, 24);
}

async function ensureStickerPreview(entry) {
  const found = [...state.history.values()].flat().find((message) => {
    const meta = stickerMetadata(message);
    return meta && meta.packageId === entry.packageId && meta.stickerId === entry.stickerId && meta.version === entry.version;
  });
  if (!found) return;
  const media = await requestMedia(found, true).catch(() => null);
  if (media?.dataUrl) entry.previewUrl = media.dataUrl;
  else if (media?.url) entry.previewUrl = media.url;
}

function renderStickerPicker() {
  const box = $("recentStickers");
  box.textContent = "";
  if (!state.recentStickers.length) {
    const empty = document.createElement("div");
    empty.className = "sticker-empty";
    empty.textContent = "まだ受信したスタンプがありません。下でSTKPKGID / STKID / STKVERを指定できます。";
    box.append(empty);
    return;
  }
  for (const entry of state.recentStickers) {
    const card = document.createElement("div");
    card.className = "sticker-option";
    const preview = document.createElement("div");
    preview.className = "sticker-option-preview";
    if (entry.previewUrl) {
      const img = document.createElement("img");
      img.src = entry.previewUrl;
      img.alt = "スタンプ";
      img.loading = "lazy";
      img.onerror = () => { img.remove(); preview.textContent = "🙂"; };
      preview.append(img);
    } else {
      preview.textContent = "🙂";
      void ensureStickerPreview(entry).then(() => renderStickerPicker());
    }
    const id = document.createElement("div");
    id.className = "sticker-id";
    id.textContent = `${entry.packageId} / ${entry.stickerId}`;
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "このスタンプを送信";
    send.onclick = async (event) => {
      event.stopPropagation();
      await sendStickerValue(entry);
    };
    card.append(preview, id, send);
    card.onclick = () => {
      $("stickerPackage").value = entry.packageId;
      $("stickerId").value = entry.stickerId;
      $("stickerVersion").value = entry.version;
      state.selectedSticker = entry;
    };
    box.append(card);
  }
}

function albumKind(photo) {
  const rawKind = String(photo?.mediaKind || photo?.type || "").toLowerCase();
  return rawKind === "video" || photo?.obsResourceId?.sid === "v" || photo?.raw?.obsResourceId?.sid === "v" ? "video" : "image";
}

function albumPhotoKey(photo) {
  return `${state.active?.mid || ""}:${state.activeAlbum?.id || ""}:${String(photo?.id || "")}`;
}

function albumPhotoCanAutoLoad(photo) {
  // Images are safe to eager-load. Video objects can be much larger because
  // Moa may return the actual video bytes when no thumbnail URL is exposed,
  // so videos stay click-to-load unless a remote thumbnail is already known.
  if (albumKind(photo) === "image") return true;
  return Boolean(photo?.thumbnailUrl || photo?.url);
}

async function loadAlbumPhotoMedia(photo, { open = false, force = false, render = true } = {}) {
  if (!state.active || !state.activeAlbum || !photo?.id) return null;
  const key = albumPhotoKey(photo);
  const existing = state.albumMedia?.get?.(key);
  if (existing && !force) {
    if (open) openMediaViewer(existing, photo.name || (albumKind(photo) === "video" ? "動画" : "写真"));
    return existing;
  }
  if (state.albumMediaLoading.has(key)) return null;
  state.albumMediaLoading.add(key);
  state.albumMediaFailed.delete(key);
  try {
    const media = await window.lineNative.request({
      method: "album_media",
      chatMid: state.active.mid,
      albumId: state.activeAlbum.id,
      mediaId: photo.id,
      mediaKind: albumKind(photo),
      mime: photo.mime || "",
      name: photo.name || "",
      resourceOid: photo.resourceOid || photo.raw?.obsResourceId?.oid || "",
      resourceSid: photo.resourceSid || photo.raw?.obsResourceId?.sid || "",
      preview: true,
    });
    const value = media?.media || null;
    if (value) {
      const cache = state.albumMedia || (state.albumMedia = new Map());
      cache.set(key, value);
    }
    if (render && state.active?.mid && state.activeAlbum?.id) renderAlbumPhotos();
    if (open && value) openMediaViewer(value, photo.name || (albumKind(photo) === "video" ? "動画" : "写真"));
    return value;
  } catch (error) {
    state.albumMediaFailed.set(key, error?.message || String(error));
    if (open) showToast(`アルバムメディア: ${error.message}`, true);
    return null;
  } finally {
    state.albumMediaLoading.delete(key);
  }
}

async function preloadAlbumMedia(epoch) {
  if (!state.active || !state.activeAlbum) return;
  const photos = state.albumPhotos.filter(albumPhotoCanAutoLoad);
  let cursor = 0;
  while (cursor < photos.length && epoch === state.albumAutoEpoch) {
    const batch = photos.slice(cursor, cursor + 3);
    cursor += batch.length;
    await Promise.all(batch.map(async (photo) => {
      const key = albumPhotoKey(photo);
      if (state.albumMedia.has(key) || state.albumMediaLoading.has(key) || state.albumMediaFailed.has(key)) return;
      await loadAlbumPhotoMedia(photo, { render: false });
    }));
    if (epoch !== state.albumAutoEpoch) return;
    renderAlbumPhotos({ schedule: false });
  }
}

function renderAlbumList() {
  const body = $("albumBody");
  body.textContent = "";
  $("albumBack").classList.add("hidden");
  $("albumSubtitle").textContent = state.active ? `${displayName(state.active)} のアルバム` : "トークのアルバム";
  if (!state.albums.length) {
    const empty = document.createElement("div");
    empty.className = "album-empty";
    empty.innerHTML = "<div class=\"empty-icon\">▦</div><strong>アルバムがありません</strong><span>このトークに公開されているアルバムが見つかりません。</span>";
    body.append(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "album-grid";
  for (const album of state.albums) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "album-tile";
    const cover = document.createElement("div");
    cover.className = "album-cover";
    if (album.coverUrl) {
      const img = document.createElement("img");
      img.src = album.coverUrl;
      img.alt = album.name;
      img.loading = "lazy";
      img.onerror = () => { img.remove(); cover.textContent = "▦"; };
      cover.append(img);
    } else cover.textContent = "▦";
    const name = document.createElement("strong");
    name.textContent = album.name;
    const meta = document.createElement("span");
    meta.textContent = album.count ? `${album.count}件` : "写真・動画";
    card.append(cover, name, meta);
    card.onclick = () => openAlbum(album);
    grid.append(card);
  }
  body.append(grid);
}

function renderAlbumPhotos({ schedule = true } = {}) {
  const body = $("albumBody");
  body.textContent = "";
  $("albumBack").classList.remove("hidden");
  $("albumSubtitle").textContent = state.activeAlbum ? state.activeAlbum.name : "アルバム";
  const photos = state.albumPhotos;
  if (!photos.length) {
    const empty = document.createElement("div");
    empty.className = "album-empty";
    empty.innerHTML = "<div class=\"empty-icon\">▦</div><strong>写真がありません</strong><span>このアルバムには表示可能な写真・動画がありません。</span>";
    body.append(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "album-photo-grid";
  for (const photo of photos) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = `album-photo-tile ${albumKind(photo)}`;
    const key = albumPhotoKey(photo);
    const loaded = state.albumMedia?.get?.(key);
    const loading = state.albumMediaLoading.has(key);
    const failed = state.albumMediaFailed.get(key);
    const source = loaded?.dataUrl || loaded?.url || photo.thumbnailUrl || photo.url;
    if (source) {
      if (albumKind(photo) === "video" && !loaded?.dataUrl) {
        const img = document.createElement("img"); img.src = source; img.alt = photo.name || "動画"; img.loading = "lazy"; tile.append(img);
        const play = document.createElement("span"); play.className = "album-play"; play.textContent = "▶";
        tile.append(play);
      } else if (loaded?.dataUrl && albumKind(photo) === "video") {
        const video = document.createElement("video"); video.src = loaded.dataUrl; video.muted = true; video.preload = "metadata"; tile.append(video);
        const play = document.createElement("span"); play.className = "album-play"; play.textContent = "▶"; tile.append(play);
      } else {
        const img = document.createElement("img"); img.src = source; img.alt = photo.name || "写真"; img.loading = "lazy"; tile.append(img);
      }
    } else if (loading) {
      const spinner = document.createElement("span");
      spinner.className = "album-media-loading";
      spinner.textContent = "読み込み中…";
      tile.append(spinner);
    } else if (failed) {
      const unavailable = document.createElement("span");
      unavailable.className = "album-media-failed";
      unavailable.textContent = "再試行";
      tile.append(unavailable);
    } else {
      tile.textContent = albumKind(photo) === "video" ? "▶" : "▧";
    }
    tile.onclick = async () => {
      const value = await loadAlbumPhotoMedia(photo, { open: true, force: Boolean(failed) });
      if (!value && !failed && (photo.thumbnailUrl || photo.url)) {
        const fallback = { kind: albumKind(photo), url: photo.thumbnailUrl || photo.url, name: photo.name || "メディア" };
        openMediaViewer(fallback, fallback.name);
      }
    };
    grid.append(tile);
  }
  body.append(grid);
  // Progressive eager loading: fill the grid with actual thumbnails without
  // requiring the user to click each tile. The worker pool is intentionally
  // small to avoid flooding the Moa/object-storage path.
  if (schedule) {
    const autoEpoch = ++state.albumAutoEpoch;
    void preloadAlbumMedia(autoEpoch);
  }
  if (state.albumContinuation) {
    const load = document.createElement("button");
    load.type = "button";
    load.className = "secondary album-more";
    load.textContent = "さらに読み込む";
    load.onclick = loadMoreAlbumPhotos;
    body.append(load);
  }
}

async function loadAlbums({ refresh = false } = {}) {
  if (!state.active || state.albumLoading) return;
  state.albumLoading = true;
  const body = $("albumBody");
  if (!refresh && !state.albums.length && !state.activeAlbum) body.innerHTML = "<div class=\"album-loading\"><div class=\"spinner\"></div>アルバムを取得しています…</div>";
  try {
    if (refresh || !state.albums.length) {
      const response = await window.lineNative.request({ method: "albums", chatMid: state.active.mid, force: refresh });
      state.albums = Array.isArray(response?.albums) ? response.albums : [];
    }
    if (state.activeAlbum) renderAlbumPhotos(); else renderAlbumList();
  } catch (error) {
    body.textContent = "";
    const empty = document.createElement("div"); empty.className = "album-empty error";
    empty.innerHTML = `<strong>アルバムを取得できませんでした</strong><span>${escapeText(error.message)}</span><small>LINEJSのMoa/Album APIを利用できない場合は、診断画面のMoa API一覧を確認できます。</small>`;
    body.append(empty);
    showToast(`アルバム: ${error.message}`, true);
  } finally {
    state.albumLoading = false;
  }
}

async function openAlbum(album) {
  if (!state.active || !album?.id || state.albumLoading) return;
  state.activeAlbum = album;
  state.albumPhotos = [];
  state.albumContinuation = null;
  $("albumBody").innerHTML = "<div class=\"album-loading\"><div class=\"spinner\"></div>写真を取得しています…</div>";
  state.albumLoading = true;
  try {
    const response = await window.lineNative.request({ method: "album_photos", chatMid: state.active.mid, albumId: album.id, limit: 50, force: true });
    const result = response?.result || {};
    state.albumPhotos = Array.isArray(result.photos) ? result.photos : [];
    state.albumContinuation = result.continuationToken || null;
    renderAlbumPhotos();
  } catch (error) {
    $("albumBody").innerHTML = `<div class=\"album-empty error\"><strong>写真を取得できませんでした</strong><span>${escapeText(error.message)}</span></div>`;
    showToast(`アルバム写真: ${error.message}`, true);
  } finally {
    state.albumLoading = false;
  }
}

async function loadMoreAlbumPhotos() {
  if (!state.active || !state.activeAlbum || !state.albumContinuation || state.albumLoading) return;
  state.albumLoading = true;
  try {
    const response = await window.lineNative.request({ method: "album_photos", chatMid: state.active.mid, albumId: state.activeAlbum.id, continuationToken: state.albumContinuation, limit: 50 });
    const result = response?.result || {};
    const seen = new Set(state.albumPhotos.map((photo) => String(photo.id)));
    for (const photo of Array.isArray(result.photos) ? result.photos : []) if (!seen.has(String(photo.id))) { state.albumPhotos.push(photo); seen.add(String(photo.id)); }
    state.albumContinuation = result.continuationToken || null;
    renderAlbumPhotos();
  } catch (error) {
    showToast(`追加読み込み: ${error.message}`, true);
  } finally {
    state.albumLoading = false;
  }
}

async function openAlbums() {
  if (!state.active) return;
  state.activeAlbum = null;
  state.albumPhotos = [];
  state.albumContinuation = null;
  state.albums = [];
  state.albumMedia = new Map();
  state.albumMediaLoading = new Set();
  state.albumMediaFailed = new Map();
  state.albumAutoEpoch++;
  $("albummodal").classList.remove("hidden");
  await loadAlbums({ refresh: true });
}

function closeAlbums() {
  state.albumAutoEpoch++;
  $("albummodal").classList.add("hidden");
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[char]));
}

function openStickerPicker() {
  if (!state.active) return;
  renderStickerPicker();
  $("stickerPackage").value = state.selectedSticker?.packageId || "";
  $("stickerId").value = state.selectedSticker?.stickerId || "";
  $("stickerVersion").value = state.selectedSticker?.version || "100";
  $("stickermodal").classList.remove("hidden");
  $("stickerPackage").focus();
}

async function sendStickerValue(entry = null) {
  if (!state.active) return;
  const packageId = String(entry?.packageId ?? $("stickerPackage").value ?? "").trim();
  const stickerId = String(entry?.stickerId ?? $("stickerId").value ?? "").trim();
  const version = String(entry?.version ?? $("stickerVersion").value ?? "100").trim() || "100";
  if (!/^\d+$/.test(packageId) || !/^\d+$/.test(stickerId) || !/^\d+$/.test(version)) {
    showToast("STKPKGID / STKID / STKVER は数字で入力してください", true);
    return;
  }
  const previewUrl = entry?.previewUrl || null;
  const local = {
    id: `local-sticker-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    chatMid: state.active.mid,
    fromMid: state.profile?.mid || null,
    toMid: state.active.mid,
    text: "",
    createdTime: Date.now(),
    isMyMessage: true,
    encrypted: false,
    pending: true,
    mediaKind: "sticker",
    sticker: { packageId, stickerId, version },
    stickerUrl: previewUrl,
  };
  rememberSticker({ contentMetadata: { STKPKGID: packageId, STKID: stickerId, STKVER: version }, stickerUrl: previewUrl });
  const list = state.history.get(state.active.mid) || [];
  list.push(local);
  sortHistoryInPlace(state.active.mid);
  state.history.set(state.active.mid, list);
  renderMessages(list, { scroll: "bottom" });
  $("stickermodal").classList.add("hidden");
  try {
    const response = await window.lineNative.request({ method: "send_sticker", chatMid: state.active.mid, packageId, stickerId, version });
    const server = response?.message || {};
    Object.assign(local, server, { mediaKind: "sticker", sticker: { packageId, stickerId, version }, pending: false, sent: true, failed: false });
    if (server.id) local.id = server.id;
    renderMessages(list, { scroll: "bottom" });
    updateChatFromMessage(state.active.mid, local);
    renderChats();
    showToast("スタンプを送信しました（通常送信）");
  } catch (error) {
    local.pending = false;
    local.failed = true;
    renderMessages(list, { scroll: "bottom" });
    showToast(`スタンプ送信失敗: ${error.message}`, true);
  }
}

function clearMediaCacheFor(chatMid) {
  for (const key of state.media.keys()) if (key.startsWith(`${chatMid}:`)) state.media.delete(key);
}

async function requestMedia(message, preview = true, force = false) {
  const key = mediaKey(message);
  const current = state.media.get(key);
  if (current && (current.preview === false || current.preview === preview)) return current;
  if (state.mediaLoading.has(`${key}:${preview}`)) return null;
  state.mediaLoading.add(`${key}:${preview}`);
  try {
    const response = await window.lineNative.request({
      method: "message_media",
      chatMid: message.chatMid || state.active?.mid,
      messageId: message.id,
      preview,
      force,
    });
    const media = response?.media || null;
    if (media) {
      const old = state.media.get(key);
      state.media.set(key, { ...(old || {}), ...media });
    }
    return media;
  } finally {
    state.mediaLoading.delete(`${key}:${preview}`);
  }
}

function formatBytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function safeFileName(name, fallback = "LINE-media") {
  const cleaned = String(name || fallback).replace(/[\\/:*?"<>|\x00-\x1F]/g, "_").trim();
  return cleaned || fallback;
}

function downloadMedia(media, name = "LINE-media") {
  const href = media?.dataUrl || media?.url;
  if (!href) { showToast("保存できるデータがありません", true); return; }
  const a = document.createElement("a");
  a.href = href;
  a.download = safeFileName(name, "LINE-media");
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

function openMediaViewer(media, title = "メディア") {
  if (!media?.dataUrl && !media?.url) return;
  const modal = $("mediaModal");
  const body = $("mediaBody");
  const caption = $("mediaCaption");
  body.textContent = "";
  caption.textContent = title;
  if (media.kind === "video") {
    const video = document.createElement("video");
    video.className = "viewer-video";
    video.controls = true; video.autoplay = true; video.playsInline = true;
    video.src = media.dataUrl || media.url;
    body.append(video);
  } else if (media.kind === "audio") {
    const audio = document.createElement("audio");
    audio.className = "viewer-audio"; audio.controls = true; audio.autoplay = true;
    audio.src = media.dataUrl || media.url;
    body.append(audio);
  } else {
    const img = document.createElement("img");
    img.src = media.dataUrl || media.url;
    img.alt = title;
    img.className = media.kind === "sticker" ? "viewer-image sticker-viewer" : "viewer-image";
    img.draggable = false;
    body.append(img);
  }
  if (media.kind === "file" && media.dataUrl) {
    const link = document.createElement("a");
    link.className = "media-download viewer-download";
    link.href = media.dataUrl; link.download = safeFileName(media.name, "LINE-file");
    link.textContent = "保存";
    body.append(link);
  }
  const save = $("mediaSave");
  save.classList.toggle("hidden", !(media.dataUrl || media.url));
  save.textContent = media.kind === "file" ? "保存" : "保存";
  save.onclick = () => downloadMedia(media, media.name || `${title}.${media.kind === "sticker" ? "png" : "bin"}`);
  modal.classList.remove("hidden");
  $("mediaClose").focus();
}

async function loadAndRerender(message, preview = true, force = false) {
  try {
    const media = await requestMedia(message, preview, force);
    renderMessages(state.history.get(message.chatMid) || [], { scroll: "none" });
    if (media?.unavailable) return media;
    return media;
  } catch (error) {
    showToast(`${messageKind(message) || "メディア"}: ${error.message}`, true);
    return null;
  }
}

function mediaLoadButton(message, label, preview = true, force = false) {
  const button = document.createElement("button");
  button.className = "media-load";
  button.textContent = label;
  button.dataset.autoload = preview ? "1" : "0";
  button.loadMedia = async () => {
    if (button.disabled || !button.isConnected) return null;
    button.disabled = true;
    button.textContent = "読み込み中…";
    try {
      await loadAndRerender(message, preview, force);
      return true;
    } catch {
      button.disabled = false;
      button.dataset.queued = "0";
      button.textContent = `${label}（再試行）`;
      return false;
    }
  };
  button.onclick = async (event) => {
    event.stopPropagation();
    await button.loadMedia();
  };
  return button;
}

function renderMediaContent(container, message) {
  const kind = messageKind(message);
  if (!kind) return false;
  const media = state.media.get(mediaKey(message));

  if (media?.unavailable) {
    container.classList.add("media-bubble", "media-unavailable");
    const title = document.createElement("div"); title.className = "media-unavailable-title"; title.textContent = kind === "image" ? "写真" : kind === "sticker" ? "スタンプ" : kind === "video" ? "動画" : kind === "audio" ? "音声" : "ファイル";
    const detail = document.createElement("div"); detail.className = "media-unavailable-detail"; detail.textContent = media.reason || "このメディアは現在取得できません";
    const retry = mediaLoadButton(message, "再取得", true, true);
    container.append(title, detail, retry);
    return true;
  }

  if (message?.attachment && message?.fileName) {
    const card = document.createElement("div"); card.className = "file-card outgoing-file-card";
    const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = kind === "image" ? "▧" : kind === "video" ? "▶" : kind === "audio" ? "♫" : "▧";
    const main = document.createElement("div"); main.className = "file-main";
    const name = document.createElement("strong"); name.textContent = message.fileName;
    const size = document.createElement("small"); size.textContent = message.fileSize ? formatBytes(message.fileSize) : (message.mime || "添付ファイル");
    main.append(name, size);
    const status = document.createElement("span"); status.className = `attachment-status ${message.failed ? "failed" : message.pending ? "pending" : "sent"}`; status.textContent = message.failed ? "送信失敗" : message.pending ? "送信中…" : "送信済み";
    card.append(icon, main, status);
    container.classList.add("media-bubble", "outgoing-media"); container.append(card);
    return true;
  }

  if (kind === "sticker") {
    if (media?.dataUrl || media?.url || message.stickerUrl) {
      const img = document.createElement("img");
      img.className = "sticker-image";
      img.alt = "スタンプ";
      img.src = media?.dataUrl || media?.url || message.stickerUrl;
      img.loading = "lazy";
      img.onclick = () => openMediaViewer({ ...(media || {}), kind: "sticker", url: img.src }, "スタンプ");
      container.classList.add("media-bubble");
      const actions = document.createElement("div");
      actions.className = "media-actions";
      const save = document.createElement("button"); save.className = "media-mini-action"; save.textContent = "保存";
      save.onclick = (event) => { event.stopPropagation(); downloadMedia(media || { url: img.src }, `sticker-${message.id}.png`); };
      actions.append(save);
      container.append(img, actions);
      return true;
    }
    container.classList.add("media-bubble", "media-deferred");
    const meta = stickerMetadata(message);
    if (meta) rememberSticker(message);
    container.append(mediaLoadButton(message, "スタンプを読み込む", true));
    return true;
  }

  if (kind === "image") {
    if (media?.dataUrl) {
      const img = document.createElement("img");
      img.className = "photo-thumb"; img.src = media.dataUrl; img.alt = "写真"; img.loading = "lazy";
      img.onclick = async (event) => {
        event.stopPropagation();
        try {
          const full = media.preview === false ? media : await requestMedia(message, false);
          openMediaViewer(full || media, "写真");
        } catch (error) {
          openMediaViewer(media, "写真"); showToast(`高画質画像: ${error.message}`, true);
        }
      };
      container.classList.add("media-bubble");
      const actions = document.createElement("div"); actions.className = "media-actions";
      const save = document.createElement("button"); save.className = "media-mini-action"; save.textContent = "保存";
      save.onclick = async (event) => {
        event.stopPropagation();
        try {
          const full = media.preview === false ? media : await requestMedia(message, false);
          downloadMedia(full || media, media?.name || `photo-${message.id}.jpg`);
        } catch (error) { showToast(`保存: ${error.message}`, true); }
      };
      actions.append(save);
      const hint = document.createElement("span"); hint.className = "media-hint"; hint.textContent = media.preview === false ? "高画質" : "クリックで拡大";
      actions.append(hint);
      container.append(img, actions);
      return true;
    }
    container.classList.add("media-bubble", "media-deferred");
    container.append(mediaLoadButton(message, "写真を表示", true));
    return true;
  }

  if (kind === "video") {
    if (media?.dataUrl) {
      const video = document.createElement("video");
      video.className = "inline-video"; video.controls = true; video.preload = "metadata"; video.playsInline = true; video.src = media.dataUrl;
      video.addEventListener("dblclick", () => openMediaViewer(media, media.name || "動画"));
      container.classList.add("media-bubble");
      const actions = document.createElement("div"); actions.className = "media-actions";
      const save = document.createElement("button"); save.className = "media-mini-action"; save.textContent = "保存"; save.onclick = (e) => { e.stopPropagation(); downloadMedia(media, media.name || `video-${message.id}.mp4`); };
      actions.append(save);
      container.append(video, actions);
      return true;
    }
    container.classList.add("media-bubble");
    container.append(mediaLoadButton(message, "動画を読み込む", false));
    return true;
  }

  if (kind === "audio") {
    if (media?.dataUrl) {
      const audio = document.createElement("audio");
      audio.className = "inline-audio"; audio.controls = true; audio.preload = "metadata"; audio.src = media.dataUrl;
      container.classList.add("media-bubble");
      const title = document.createElement("div"); title.className = "media-title"; title.textContent = media.name || "音声";
      const actions = document.createElement("div"); actions.className = "media-actions";
      const save = document.createElement("button"); save.className = "media-mini-action"; save.textContent = "保存"; save.onclick = (e) => { e.stopPropagation(); downloadMedia(media, media.name || `audio-${message.id}.m4a`); };
      actions.append(save);
      container.append(title, audio, actions);
      return true;
    }
    container.classList.add("media-bubble");
    container.append(mediaLoadButton(message, "音声を読み込む", false));
    return true;
  }

  if (kind === "file") {
    const card = document.createElement("div"); card.className = "file-card";
    const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = "▧";
    const main = document.createElement("div"); main.className = "file-main";
    const name = document.createElement("strong"); name.textContent = media?.name || message?.fileName || "ファイル";
    const size = document.createElement("small"); size.textContent = media?.size ? formatBytes(media.size) : "ファイルメッセージ";
    main.append(name, size);
    const action = document.createElement("button"); action.className = "media-load"; action.textContent = media?.dataUrl ? "保存" : "読み込む";
    action.onclick = async (event) => { event.stopPropagation(); if (!media?.dataUrl) await loadAndRerender(message, false); else downloadMedia(media, media.name || `file-${message.id}`); };
    card.append(icon, main, action); container.classList.add("media-bubble"); container.append(card); return true;
  }

  return false;
}

let mediaHydrationChain = Promise.resolve();

function hydrateMedia() {
  const box = $("messages");
  const targets = [...box.querySelectorAll('[data-autoload="1"]')];
  const enqueue = (button) => {
    if (!button || button.dataset.queued === "1") return;
    button.dataset.queued = "1";
    mediaHydrationChain = mediaHydrationChain.then(async () => {
      if (!button.isConnected || button.disabled) return;
      if (typeof button.loadMedia === "function") await button.loadMedia();
      // The adapter serializes the actual LINE media downloads too. Waiting for
      // the full load here prevents the renderer from creating a burst of IPC
      // requests when many media messages enter the viewport together.
    }).catch(() => {});
  };
  if (!targets.length || !("IntersectionObserver" in window)) {
    targets.slice(0, 3).forEach(enqueue);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      enqueue(entry.target);
    }
  }, { root: box, rootMargin: "320px 0px" });
  for (const target of targets) observer.observe(target);
}

function makeMessageView(message, previous = null) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg ${message.isMyMessage ? "mine" : "theirs"}`;
  wrapper.dataset.messageId = String(message.id ?? "");

  if (!message.isMyMessage && (!previous || previous.fromMid !== message.fromMid)) {
    const senderRow = document.createElement("div"); senderRow.className = "sender-row";
    const senderEntity = { mid: message.fromMid, name: message.fromName, pictureStatus: message.fromPictureStatus, avatarUrls: message.fromAvatarUrls };
    senderRow.append(makeSmallAvatar(senderEntity), Object.assign(document.createElement("span"), { textContent: message.fromName || "相手" }));
    wrapper.append(senderRow);
  }

  const bubbleRow = document.createElement("div");
  bubbleRow.className = "bubble-row";
  const bubble = document.createElement("div");
  bubble.className = `bubble ${message.isMyMessage ? "mine" : "theirs"}`;
  const hasMedia = renderMediaContent(bubble, message);
  if (!hasMedia) {
    bubble.textContent = messageText(message);
    bubble.title = "クリックでコピー";
    bubble.onclick = async () => {
      try {
        await navigator.clipboard.writeText(message.text || "");
        showToast("メッセージをコピーしました");
      } catch {
        showToast("コピーできませんでした", true);
      }
    };
  } else {
    bubble.title = "メディアを表示";
  }
  bubbleRow.append(bubble);
  if (message.text && !hasMedia) {
    const copy = document.createElement("button");
    copy.className = "message-copy";
    copy.textContent = "コピー";
    copy.onclick = bubble.onclick;
    bubbleRow.append(copy);
  }
  wrapper.append(bubbleRow);

  const meta = document.createElement("div");
  meta.className = "msgmeta";
  const name = document.createElement("span");
  name.textContent = message.isMyMessage ? "自分" : (message.fromName || "相手");
  const time = document.createElement("span");
  time.textContent = formatTime(message.createdTime) || "--:--";
  meta.append(name, time);
  if (message.encrypted) {
    const lock = document.createElement("span");
    lock.className = "msgstatus";
    lock.textContent = "E2EE";
    meta.append(lock);
  }
  if (message.pending) {
    const pending = document.createElement("span");
    pending.className = "msgstatus";
    pending.textContent = "送信中";
    meta.append(pending);
  }
  if (message.sent) {
    const sent = document.createElement("span");
    sent.className = "msgstatus";
    sent.textContent = "送信済み";
    meta.append(sent);
  }
  if (message.failed) {
    const failed = document.createElement("span");
    failed.className = "message-failed";
    failed.textContent = "送信失敗";
    meta.append(failed);
  }
  if (message.isEdited) {
    const edited = document.createElement("span");
    edited.textContent = "編集済み";
    meta.append(edited);
  }
  wrapper.append(meta);
  return wrapper;
}

function renderMessages(messages, { scroll = "auto" } = {}) {
  const box = $("messages");
  const wasNear = nearBottom();
  box.textContent = "";
  if (!messages?.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "メッセージはありません";
    box.append(empty);
    $("jumpLatest").classList.add("hidden");
    return;
  }

  const orderedMessages = sortMessagesChronologically(messages);
  let previous = null;
  for (const message of orderedMessages) {
    const day = formatDay(message.createdTime);
    const previousDay = formatDay(previous?.createdTime);
    if (day && day !== previousDay) {
      const separator = document.createElement("div");
      separator.className = "day-separator";
      separator.textContent = day;
      box.append(separator);
    }
    box.append(makeMessageView(message, previous));
    previous = message;
  }

  if (scroll === "bottom" || (scroll === "auto" && wasNear)) {
    box.scrollTop = box.scrollHeight;
    $("jumpLatest").classList.add("hidden");
  }
  queueMicrotask(hydrateMedia);
}

function updateInfoFromChat(chat) {
  const name = displayName(chat);
  updateAvatar("infoAvatar", chat, "bigavatar", name);
  $("infoName").textContent = name;
  $("infoMid").textContent = chat?.mid || "";
  $("infoType").textContent = typeName(chat);
  $("infoMembers").textContent = chat?.memberCount ?? "不明";
  $("infoSource").textContent = nameSource(chat);
  $("aliasInput").value = prefs.aliases[chat?.mid] || "";
  $("toggleFavorite").textContent = isFavorite(chat) ? "お気に入りから外す" : "お気に入りに追加";
  $("favoriteChat").textContent = isFavorite(chat) ? "★" : "☆";
}

async function updateInfo(chat) {
  if (!chat) return;
  updateInfoFromChat(chat);
  const members = Array.isArray(chat?.memberNames) ? chat.memberNames.filter(Boolean) : [];
  renderMemberNames(members);
  try {
    if (state.chatInfo.has(chat.mid)) {
      applyChatInfo(state.chatInfo.get(chat.mid));
      return;
    }
    const response = await window.lineNative.request({ method: "chat_info", chatMid: chat.mid });
    if (response?.info) {
      state.chatInfo.set(chat.mid, response.info);
      applyChatInfo(response.info);
    }
  } catch (error) {
    $("infoNote").textContent = `追加情報を取得できませんでした: ${error.message}`;
  }
}

function applyChatInfo(info) {
  if (!state.active || info.chatMid && info.chatMid !== state.active.mid) return;
  const chat = state.chats.find((item) => item.mid === state.active?.mid) || state.active;
  if (info.name && info.name !== info.mid) chat.name = info.name;
  if (info.memberCount != null) chat.memberCount = info.memberCount;
  if (Array.isArray(info.memberNames)) chat.memberNames = info.memberNames;
  if (Array.isArray(info.members)) chat.members = info.members;
  if (info.pictureStatus) chat.pictureStatus = info.pictureStatus;
  if (Array.isArray(info.avatarUrls)) chat.avatarUrls = info.avatarUrls;
  updateInfoFromChat(chat);
  const members = Array.isArray(info.members) && info.members.length ? info.members : (Array.isArray(info.memberNames) ? info.memberNames.filter(Boolean) : []);
  renderMemberNames(members);
  if (info.groupKey?.present) $("infoNote").textContent = `E2EEグループキー: ${info.groupKey.keyId ?? "取得済み"}`;
  else $("infoNote").textContent = "名前が取得できない場合のみMIDを補助情報として表示します。";
}

function renderMemberNames(members) {
  const section = $("memberList");
  const items = $("memberItems");
  items.textContent = "";
  if (!members.length) { section.classList.add("hidden"); $("memberCountLabel").textContent = ""; return; }
  section.classList.remove("hidden"); $("memberCountLabel").textContent = `${members.length}人`;
  for (const raw of members) {
    const member = typeof raw === "string" ? { name: raw, mid: null } : raw;
    const row = document.createElement("button"); row.type = "button"; row.className = "member-item";
    row.append(makeSmallAvatar(member), Object.assign(document.createElement("span"), { className: "member-name", textContent: member.name || member.mid || "不明" }));
    row.onclick = () => { if (member.mid) selectChat({ mid: member.mid, name: member.name || member.mid, kind: "USER", type: 0, pictureStatus: member.pictureStatus, avatarUrls: member.avatarUrls }); };
    items.append(row);
  }
}

async function selectChat(chat, { fromFriend = false } = {}) {
  if (!state.authenticated || !chat?.mid) return;
  if (fromFriend) {
    const existing = state.chats.find((item) => item.mid === chat.mid);
    if (existing) chat = existing;
    else {
      chat = {
        mid: chat.mid,
        name: chat.displayName || chat.name || chat.mid,
        type: 0,
        kind: "USER",
        virtual: true,
        memberCount: 2,
        pictureStatus: chat.pictureStatus ?? null,
        avatarUrls: chat.avatarUrls ?? [],
        raw: chat.raw ?? {},
      };
      state.chats.push(chat);
    }
  }
  ensureActiveVisible();
  state.view = "messages";
  state.active = chat;
  state.unread.delete(chat.mid);
  state.activeAlbum = null;
  state.albumPhotos = [];
  state.albumContinuation = null;
  state.albumMedia = new Map();
  $("albummodal")?.classList.add("hidden");
  renderChats();
  $("welcome").classList.add("hidden");
  $("friendsHome").classList.add("hidden");
  $("settingsHome").classList.add("hidden");
  $("chatview").classList.remove("hidden");
  $("search").value = "";
  $("chatname").textContent = displayName(chat);
  $("chatmeta").textContent = `${typeName(chat)}${chat?.memberCount ? ` · ${chat.memberCount}人` : ""}`;
  updateAvatar("avatar", chat, "avatar", displayName(chat));
  updateInfo(chat);
  $("messages").innerHTML = `<div class="empty"><div class="spinner"></div><span>メッセージを読み込みます</span></div>`;
  updateCharCount();

  try {
    const response = await window.lineNative.request({ method: "history", chatMid: chat.mid, limit: 80 });
    clearMediaCacheFor(chat.mid);
    state.history.set(chat.mid, response.messages || []);
    for (const message of response.messages || []) rememberSticker(message);
    renderMessages(response.messages || [], { scroll: "bottom" });
    window.lineNative.request({ method: "mark_read", chatMid: chat.mid }).catch(() => {});
    renderChats();
  } catch (error) {
    $("messages").textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `履歴を取得できません: ${error.message}`;
    $("messages").append(empty);
    showToast(`履歴取得: ${error.message}`, true);
  }
}

async function loadChats({ silent = false } = {}) {
  if (!state.authenticated || state.loadingChats) return;
  state.loadingChats = true;
  if (!silent) setStatus("トーク一覧を更新中", "busy");
  try {
    const response = await window.lineNative.request({ method: "chats" });
    state.chats = (response.chats || []).map(syncChatPrefs);
    renderChats();
    if (!state.active && state.chats.length && state.view === "messages") await selectChat(state.chats[0]);
    if (!silent) setStatus("接続済み", "online");
  } catch (error) {
    showToast(`トーク一覧: ${error.message}`, true);
    setStatus("通信エラー", "error");
  } finally {
    state.loadingChats = false;
  }
}

async function loadFriends(silent = false) {
  if (!state.authenticated || state.loadingFriends) return;
  state.loadingFriends = true;
  try {
    const response = await window.lineNative.request({ method: "friends" });
    state.friends = response.friends || [];
    renderFriends();
  } catch (error) {
    if (!silent) showToast(`友だち一覧: ${error.message}`, true);
  } finally {
    state.loadingFriends = false;
  }
}

function openFriend(friend) {
  selectChat(friend, { fromFriend: true });
}

function toggleFavoriteMid(mid) {
  if (!mid) return;
  const index = prefs.favorites.indexOf(mid);
  if (index >= 0) prefs.favorites.splice(index, 1);
  else prefs.favorites.push(mid);
  for (const item of state.chats) if (item.mid === mid) item.favorite = isFavorite(item);
  savePrefs();
  if (state.active?.mid === mid) updateInfoFromChat(state.active);
}

function saveAlias() {
  if (!state.active?.mid) return;
  const value = $("aliasInput").value.trim();
  if (value) prefs.aliases[state.active.mid] = value;
  else delete prefs.aliases[state.active.mid];
  savePrefs();
  updateInfoFromChat(state.active);
  $("chatname").textContent = displayName(state.active);
  updateAvatar("avatar", state.active, "avatar", displayName(state.active));
  renderChats();
  renderFriends();
  showToast(value ? "表示名を保存しました" : "表示名を元に戻しました");
}

async function sendTextValue(text) {
  if (!state.active || !String(text || "").trim()) return;
  const cleanText = String(text).trim();
  const local = {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    chatMid: state.active.mid,
    fromMid: state.profile?.mid || null,
    toMid: state.active.mid,
    text: cleanText,
    createdTime: Date.now(),
    isMyMessage: true,
    encrypted: true,
    pending: true,
  };
  const list = state.history.get(state.active.mid) || [];
  list.push(local);
  sortHistoryInPlace(state.active.mid);
  state.history.set(state.active.mid, list);
  renderMessages(list, { scroll: "bottom" });
  state.pendingMessages.set(local.id, local);
  try {
    const response = await window.lineNative.request({ method: "send_text", chatMid: state.active.mid, text: cleanText, e2ee: true });
    local.pending = false;
    local.sent = true;
    const oldId = local.id;
    if (response?.message?.id) local.id = response.message.id;
    state.pendingMessages.delete(oldId);
    state.pendingMessages.delete(local.id);
    updateChatFromMessage(state.active.mid, local);
    renderMessages(list, { scroll: "bottom" });
    renderChats();
  } catch (error) {
    local.pending = false;
    local.failed = true;
    renderMessages(list, { scroll: "bottom" });
    throw error;
  }
}

async function sendAttachment() {
  if (!state.active || !state.attachment) return;
  const attachment = { ...state.attachment };
  const caption = $("message").value.trim();
  state.attachment = null;
  $("message").value = "";
  autoResize();
  renderAttachmentPreview();

  const local = {
    id: `local-file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    chatMid: state.active.mid,
    fromMid: state.profile?.mid || null,
    toMid: state.active.mid,
    text: "",
    createdTime: Date.now(),
    isMyMessage: true,
    encrypted: false,
    pending: true,
    attachment: true,
    mediaKind: attachment.mime.startsWith("image/") ? "image" : attachment.mime.startsWith("video/") ? "video" : attachment.mime.startsWith("audio/") ? "audio" : "file",
    fileName: attachment.name,
    fileSize: attachment.size || null,
    mime: attachment.mime,
  };
  const list = state.history.get(state.active.mid) || [];
  list.push(local);
  sortHistoryInPlace(state.active.mid);
  state.history.set(state.active.mid, list);
  renderMessages(list, { scroll: "bottom" });
  state.pendingMessages.set(local.id, local);
  updateCharCount();

  try {
    const response = await window.lineNative.request({
      method: "send_file",
      chatMid: state.active.mid,
      filePath: attachment.path,
      caption,
    });
    const server = response?.message || {};
    Object.assign(local, server, {
      attachment: true,
      mediaKind: server.mediaKind || local.mediaKind,
      fileName: server.fileName || local.fileName,
      fileSize: server.fileSize || local.fileSize,
      mime: server.mime || local.mime,
      pending: false,
      sent: true,
      failed: false,
    });
    const oldId = local.id;
    if (server.id) local.id = server.id;
    state.pendingMessages.delete(oldId);
    state.pendingMessages.delete(local.id);
    updateChatFromMessage(state.active.mid, local);
    renderMessages(list, { scroll: "bottom" });
    renderChats();
    showToast(`${attachment.name} を送信しました`);

    if (caption) {
      try { await sendTextValue(caption); }
      catch (error) { showToast(`コメント送信: ${error.message}`, true); $("message").value = caption; autoResize(); updateCharCount(); }
    }
  } catch (error) {
    local.pending = false;
    local.failed = true;
    state.attachment = attachment;
    $("message").value = caption;
    renderAttachmentPreview();
    renderMessages(list, { scroll: "bottom" });
    showToast(`ファイル送信失敗: ${error.message}`, true);
  }
}

async function sendText(event) {
  event.preventDefault();
  if (!state.active) return;
  if (state.attachment) { await sendAttachment(); return; }
  const input = $("message");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoResize();
  updateCharCount();
  try { await sendTextValue(text); }
  catch (error) {
    input.value = text;
    autoResize();
    updateCharCount();
    showToast(`送信失敗: ${error.message}`, true);
  }
}

function updateChatFromMessage(chatMid, message) {
  const chat = state.chats.find((item) => item.mid === chatMid);
  if (!chat) return;
  chat.lastUpdate = message.createdTime ?? Date.now();
  chat.lastMessage = message;
}

function reconcileIncoming(message) {
  if (!message?.chatMid || !message.isMyMessage) return false;
  const list = state.history.get(message.chatMid) || [];
  const pending = list.find((item) => item.pending && item.isMyMessage && item.text === message.text && Math.abs(Number(item.createdTime || 0) - Number(message.createdTime || Date.now())) < 15_000);
  if (!pending) return false;
  Object.assign(pending, { ...message, pending: false, sent: true, failed: false });
  return true;
}

function acceptIncoming(message) {
  if (!message?.chatMid) return;
  rememberSticker(message);
  const chat = state.chats.find((item) => item.chatMid === message.chatMid || item.mid === message.chatMid);
  if (chat && message.chatName && (!baseName(chat) || chat.name === chat.mid)) {
    chat.name = message.chatName;
  }
  updateChatFromMessage(message.chatMid, message);
  const reconciled = reconcileIncoming(message);
  if (!reconciled) {
    const list = state.history.get(message.chatMid) || [];
    const id = String(message.id ?? `${message.createdTime}:${message.fromMid}:${message.text}`);
    const existingIndex = list.findIndex((item) => String(item.id) === id);
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...message, fileName: message.fileName || list[existingIndex].fileName };
    } else {
      list.push(message);
    }
    state.history.set(message.chatMid, list);
    sortHistoryInPlace(message.chatMid);
  }
  if (state.active?.mid === message.chatMid) {
    const wasNear = nearBottom();
    renderMessages(state.history.get(message.chatMid) || [], { scroll: wasNear ? "bottom" : "none" });
    if (!wasNear && !message.isMyMessage) $("jumpLatest").classList.remove("hidden");
  } else if (!message.isMyMessage) {
    state.unread.set(message.chatMid, (state.unread.get(message.chatMid) || 0) + 1);
  }
  renderChats();
}

function updateEdited(message) {
  if (!message?.chatMid) return;
  const list = state.history.get(message.chatMid) || [];
  const index = list.findIndex((item) => String(item.id) === String(message.id));
  if (index >= 0) list[index] = { ...list[index], ...message };
  else list.push(message);
  state.history.set(message.chatMid, list);
  sortHistoryInPlace(message.chatMid);
  if (state.active?.mid === message.chatMid) renderMessages(list, { scroll: nearBottom() ? "bottom" : "none" });
  updateChatFromMessage(message.chatMid, message);
  renderChats();
}

function updateProfileUI(profile) {
  $("profileName").textContent = profile?.displayName || "未接続";
  $("profileMid").textContent = profile?.mid || "—";
  updateAvatar("profileAvatar", profile || { displayName: "L" }, "bigavatar", profile?.displayName || "L");
  if (profile?.displayName) $("brand").textContent = initials(profile.displayName);
}

async function restoreSession() {
  if (state.restoringSession) return;
  state.restoringSession = true;
  setStatus("セッションを確認中…", "busy");
  try {
    const response = await window.lineNative.request({ method: "session" });
    const session = response?.session || {};
    if (!session.authenticated) {
      state.authenticated = false;
      setStatus(session.hasSavedToken ? "再認証が必要です" : "接続待機中");
      return false;
    }
    state.authenticated = true;
    state.profile = session.profile || null;
    updateProfileUI(state.profile);
    setStatus(state.profile?.displayName || "接続済み", "online");
    await loadChats({ silent: true });
    await loadFriends(true);
    return true;
  } catch (error) {
    state.authenticated = false;
    setStatus("接続確認に失敗", "error");
    showToast(`セッション確認: ${error.message}`, true);
    return false;
  } finally {
    state.restoringSession = false;
  }
}

async function login(mode = "auto") {
  $("login").disabled = true;
  $("loginQr").disabled = true;
  setStatus(mode === "qr" ? "QR認証を開始中…" : "LINEへ接続中…", "busy");
  try {
    const response = await window.lineNative.request({ method: mode === "qr" ? "login_qr" : "login" });
    state.authenticated = true;
    state.profile = response.profile || null;
    updateProfileUI(state.profile);
    setStatus(state.profile?.displayName || "接続済み", "online");
    await Promise.all([loadChats({ silent: true }), loadFriends(true)]);
  } catch (error) {
    setStatus("接続エラー", "error");
    showToast(error.message, true);
  } finally {
    $("login").disabled = false;
    $("loginQr").disabled = false;
  }
}

async function disconnect() {
  try {
    await window.lineNative.request({ method: "logout" });
  } catch (error) {
    showToast(`接続解除: ${error.message}`, true);
    return;
  }
  state.authenticated = false;
  state.profile = null;
  state.active = null;
  state.chats = [];
  state.friends = [];
  state.history.clear();
  state.unread.clear();
  state.chatInfo.clear();
  state.media.clear();
  state.recentStickers = [];
  state.selectedSticker = null;
  state.albums = [];
  state.activeAlbum = null;
  state.albumPhotos = [];
  state.albumContinuation = null;
  updateProfileUI(null);
  $("chatview").classList.add("hidden");
  $("settingsPanel").classList.add("hidden");
  $("welcome").classList.remove("hidden");
  setStatus("接続待機中");
  renderChats();
  renderFriends();
  showToast("接続を解除しました");
}

async function showDiagnostics() {
  $("diagmodal").classList.remove("hidden");
  try {
    const response = await window.lineNative.request({ method: "diag" });
    $("diagtext").textContent = JSON.stringify(response.diagnostics ?? response, null, 2);
  } catch (error) {
    $("diagtext").textContent = `診断取得失敗: ${error.message}`;
  }
}

function applyDensity() {
  document.body.classList.toggle("compact", prefs.density === "compact");
  $("density").value = prefs.density;
  $("enterSend").checked = prefs.enterSend;
}

function showInfo() {
  if (!state.active) return;
  $("info").classList.remove("hidden");
  $("app").classList.add("showinfo");
  updateInfo(state.active);
}

$("login").onclick = () => login("auto");
$("loginQr").onclick = () => login("qr");
$("refresh").onclick = () => loadChats();
$("search").oninput = () => state.view === "friends" ? renderFriends() : renderChats();
$("composer").onsubmit = sendText;
$("attach").onclick = pickAttachment;
$("sticker").onclick = openStickerPicker;
$("stickerClose").onclick = () => $("stickermodal").classList.add("hidden");
$("stickerSendManual").onclick = () => sendStickerValue();
$("stickermodal").onclick = (event) => { if (event.target === $("stickermodal")) $("stickermodal").classList.add("hidden"); };
$("message").oninput = () => { autoResize(); updateCharCount(); };
$("message").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && prefs.enterSend) {
    event.preventDefault();
    if (!$("sendbtn").disabled) $("composer").requestSubmit();
  }
};
$("messages").onscroll = () => {
  if (nearBottom()) $("jumpLatest").classList.add("hidden");
};
$("jumpLatest").onclick = () => {
  $("messages").scrollTo({ top: $("messages").scrollHeight, behavior: "smooth" });
  $("jumpLatest").classList.add("hidden");
};
$("details").onclick = showInfo;
$("albums").onclick = openAlbums;
$("albumClose").onclick = closeAlbums;
$("albumBack").onclick = () => { state.albumAutoEpoch++; state.activeAlbum = null; state.albumPhotos = []; state.albumContinuation = null; renderAlbumList(); };
$("albumRefresh").onclick = () => state.activeAlbum ? openAlbum(state.activeAlbum) : loadAlbums({ refresh: true });
$("albummodal").onclick = (event) => { if (event.target === $("albummodal")) closeAlbums(); };
$("markRead").onclick = async () => { if (!state.active) return; try { await window.lineNative.request({ method: "mark_read", chatMid: state.active.mid }); state.unread.delete(state.active.mid); renderChats(); showToast("既読にしました"); } catch (error) { showToast(`既読: ${error.message}`, true); } };
$("closeInfo").onclick = () => { $("info").classList.add("hidden"); $("app").classList.remove("showinfo"); };
$("favoriteChat").onclick = () => { if (state.active) { toggleFavoriteMid(state.active.mid); renderChats(); updateInfoFromChat(state.active); } };
$("toggleFavorite").onclick = () => { if (state.active) { toggleFavoriteMid(state.active.mid); renderChats(); updateInfoFromChat(state.active); } };
$("saveAlias").onclick = saveAlias;
$("aliasInput").onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); saveAlias(); } };
$("copyMid").onclick = async () => {
  if (!state.active?.mid) return;
  try { await navigator.clipboard.writeText(state.active.mid); showToast("MIDをコピーしました"); }
  catch { showToast("MIDをコピーできませんでした", true); }
};
$("qrclose").onclick = () => $("qrmodal").classList.add("hidden");
$("mediaClose").onclick = () => $("mediaModal").classList.add("hidden");
$("mediaModal").addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); $("mediaSave").click(); } });
$("mediaModal").onclick = (event) => { if (event.target === $("mediaModal")) $("mediaModal").classList.add("hidden"); };
$("diagnostics").onclick = showDiagnostics;
$("diagclose").onclick = () => $("diagmodal").classList.add("hidden");
$("diagrefresh").onclick = showDiagnostics;
$("closeSettings").onclick = () => $("settingsPanel").classList.add("hidden");
$("settingsDiagnostics").onclick = showDiagnostics;
$("disconnect").onclick = () => { if (confirm("このGUIからLINEの接続を解除しますか？保存済み認証情報は削除しません。")) disconnect(); };
$("loadFriendsHome").onclick = () => loadFriends();
$("density").onchange = () => { prefs.density = $("density").value === "compact" ? "compact" : "comfortable"; savePrefs(); applyDensity(); };
$("enterSend").onchange = () => { prefs.enterSend = $("enterSend").checked; savePrefs(); };
$("clearLocal").onclick = () => {
  if (!confirm("端末上の表示名とお気に入りを初期化しますか？")) return;
  prefs.favorites = [];
  prefs.aliases = {};
  savePrefs();
  state.chats.forEach((chat) => { chat.favorite = false; });
  renderChats();
  renderFriends();
  if (state.active) updateInfoFromChat(state.active);
  showToast("ローカル表示データを初期化しました");
};

document.querySelectorAll(".railbtn[data-view]").forEach((button) => {
  button.onclick = () => {
    const view = button.dataset.view;
    if (view === "favorites") {
      state.filter = "favorite";
      document.querySelectorAll("#chatFilters button").forEach((b) => b.classList.toggle("selected", b.dataset.filter === "favorite"));
      setView("favorites");
      return;
    }
    if (view === "messages") {
      state.filter = "all";
      document.querySelectorAll("#chatFilters button").forEach((b) => b.classList.toggle("selected", b.dataset.filter === "all"));
    }
    setView(view);
    if (view === "settings") $("settingsPanel").classList.remove("hidden");
  };
});

$("brand").onclick = () => { setView("settings"); $("settingsPanel").classList.remove("hidden"); };

document.querySelectorAll("#chatFilters button").forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll("#chatFilters button").forEach((b) => b.classList.remove("selected"));
    button.classList.add("selected");
    state.filter = button.dataset.filter;
    renderChats();
  };
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("search").focus();
    $("search").select();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    if (state.active) $("message").focus();
  }
  if (event.key === "Escape") {
    $("info").classList.add("hidden");
    $("app").classList.remove("showinfo");
    $("qrmodal").classList.add("hidden");
    $("diagmodal").classList.add("hidden");
    $("settingsPanel").classList.add("hidden");
    $("mediaModal").classList.add("hidden");
    $("stickermodal").classList.add("hidden");
    $("albummodal").classList.add("hidden");
  }
});

window.lineNative.onEvent((event) => {
  switch (event.type) {
    case "status": {
      const labels = { preparing: "接続準備中…", "token-login": "保存済み認証情報で接続中…", "saved-token-login": "保存済み認証情報で接続中…", "saved-token-invalid": "認証情報が無効です。QR認証へ切替…", "saved-token-failed": "保存済み認証情報を確認中…", "qr-login": "QR認証を待機中…", verifying: "ログインを検証中…", authenticating: "LINEへ認証中…" };
      setStatus(labels[event.state] || event.state || "接続中", "busy");
      break;
    }
    case "ready":
      state.authenticated = true;
      state.profile = event.profile || state.profile;
      updateProfileUI(state.profile);
      setStatus(state.profile?.displayName || "接続済み", "online");
      break;
    case "listening":
      state.authenticated = true;
      setStatus("接続済み", "online");
      break;
    case "message":
      acceptIncoming(event.message);
      break;
    case "message:edit":
      updateEdited(event.message);
      break;
    case "qr":
      $("qrurl").href = event.url || "#";
      $("qrurl").textContent = event.url || "認証URLを受け取れませんでした";
      $("qrmodal").classList.remove("hidden");
      break;
    case "pin":
      showToast(`LINE PIN: ${event.pin || ""}`);
      break;
    case "warning":
      showToast(event.message || "警告", true);
      break;
    case "e2eeDirect":
      setStatus("E2EE送信中…", "busy");
      break;
    case "bridge:error":
      setStatus("通信ブリッジエラー", "error");
      showToast(event.message || "通信ブリッジの起動に失敗しました", true);
      break;
    case "bridge:exit":
      state.authenticated = false;
      setStatus("通信ブリッジ停止", "error");
      break;
  }
});

applyDensity();
updateProfileUI(null);
updateCharCount();
setStatus("接続待機中");
renderChats();
renderFriends();
void restoreSession();
