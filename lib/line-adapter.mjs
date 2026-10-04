import { mkdir, chmod, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

import { jsonSafe, normalizeChat, normalizeMessage, normalizeProfile, normalizeUser } from "./normalize.mjs";

const TOKEN_KEY = "userAuthToken";
const MID_TYPES = {
  0: "USER",
  1: "ROOM",
  2: "GROUP",
  3: "SQUARE",
  4: "SQUARE_CHAT",
  5: "SQUARE_MEMBER",
  6: "BOT",
};

function stringifyError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function errorCode(error) {
  return String(error?.data?.code ?? error?.code ?? "");
}

function errorReason(error) {
  return String(error?.data?.reason ?? error?.reason ?? error?.message ?? "");
}

function midTypeName(value) {
  return MID_TYPES[Number(value)] ?? (value == null ? "UNKNOWN" : String(value));
}

export function sortMessagesChronologically(messages) {
  return [...(Array.isArray(messages) ? messages : [])].sort((a, b) => {
    const at = Number(a?.createdTime ?? a?.created_time ?? 0);
    const bt = Number(b?.createdTime ?? b?.created_time ?? 0);
    const safeA = Number.isFinite(at) ? at : 0;
    const safeB = Number.isFinite(bt) ? bt : 0;
    if (safeA !== safeB) return safeA - safeB;
    return String(a?.id ?? a?.messageId ?? "").localeCompare(String(b?.id ?? b?.messageId ?? ""));
  });
}

export function inferOutgoingMediaSpec(filename, mime = "") {
  const cleanMime = String(mime || "").toLowerCase().split(";")[0].trim();
  const name = String(filename || "attachment");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (cleanMime.startsWith("image/")) return { contentType: 1, mediaKind: "image", uploadType: "image" };
  if (cleanMime.startsWith("video/")) return { contentType: 2, mediaKind: "video", uploadType: "video" };
  if (cleanMime.startsWith("audio/")) return { contentType: 3, mediaKind: "audio", uploadType: "audio" };
  if (["jpg","jpeg","png","gif","webp","bmp","heic","heif"].includes(ext)) return { contentType: 1, mediaKind: "image", uploadType: "image" };
  if (["mp4","mov","m4v","webm","mkv","avi"].includes(ext)) return { contentType: 2, mediaKind: "video", uploadType: "video" };
  if (["mp3","m4a","aac","wav","ogg","opus","flac"].includes(ext)) return { contentType: 3, mediaKind: "audio", uploadType: "audio" };
  return { contentType: 14, mediaKind: "file", uploadType: "file" };
}

function getHeader(container, name) {
  if (!container) return null;
  const wanted = String(name).toLowerCase();
  if (typeof container.get === "function") {
    const value = container.get(name) ?? container.get(wanted);
    if (value) return String(value);
  }
  if (typeof container.entries === "function") {
    try {
      for (const [key, value] of container.entries()) if (String(key).toLowerCase() === wanted && value) return String(value);
    } catch {}
  }
  if (typeof container === "object") {
    const entry = Object.entries(container).find(([key]) => String(key).toLowerCase() === wanted);
    if (entry?.[1]) return String(entry[1]);
  }
  return null;
}

function userDisplayName(user) {
  return normalizeUser(user).displayName;
}

function getLineToType(client, mid) {
  const type = client?.base?.getToType?.(mid);
  return Number.isFinite(Number(type)) ? Number(type) : null;
}

function stringValue(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstValue(holder, keys = []) {
  if (!holder || typeof holder !== "object") return null;
  for (const key of keys) {
    const value = stringValue(holder?.[key]);
    if (value) return value;
  }
  return null;
}

function unwrapCollection(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of ["data", "result", "response", "body"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === "object") {
      const found = unwrapCollection(nested, keys);
      if (found.length) return found;
    }
  }
  return [];
}

export function normalizeAlbum(raw) {
  const nested = raw?.albumInfo && typeof raw.albumInfo === "object" ? raw.albumInfo : (raw?.album && typeof raw.album === "object" ? raw.album : null);
  const item = nested ? { ...nested, ...(raw ?? {}) } : (raw?.raw && typeof raw.raw === "object" ? { ...raw.raw, ...raw } : (raw ?? {}));
  const id = firstValue(item, ["albumId", "album_id", "id", "oid", "objectId", "object_id"]);
  const name = firstValue(item, ["name", "albumName", "album_name", "title"]) || (id ? `アルバム ${id}` : "アルバム");
  const description = firstValue(item, ["description", "desc"]) || "";
  const coverUrl = firstValue(item, ["coverUrl", "coverURL", "thumbnailUrl", "thumbnailURL", "imageUrl", "imageURL", "previewUrl", "previewURL"]);
  const createdTime = item?.createdTime ?? item?.created_time ?? item?.createdAt ?? item?.created_at ?? null;
  const updatedTime = item?.updatedTime ?? item?.updated_time ?? item?.updatedAt ?? item?.updated_at ?? null;
  const count = Number(item?.photoCount ?? item?.photo_count ?? item?.mediaCount ?? item?.media_count ?? item?.contentCount ?? item?.content_count ?? 0);
  return {
    id,
    name,
    description,
    coverUrl,
    createdTime,
    updatedTime,
    count: Number.isFinite(count) && count > 0 ? count : null,
    raw: jsonSafe(item),
  };
}

export function normalizeAlbumPhoto(raw) {
  const nested = raw?.content && typeof raw.content === "object" ? raw.content : (raw?.media && typeof raw.media === "object" ? raw.media : (raw?.photo && typeof raw.photo === "object" ? raw.photo : null));
  const item = nested ? { ...nested, ...(raw ?? {}) } : (raw?.raw && typeof raw.raw === "object" ? { ...raw.raw, ...raw } : (raw ?? {}));
  const id = firstValue(item, ["mediaId", "media_id", "photoId", "photo_id", "contentId", "content_id", "id", "oid", "objectId", "object_id"]);
  const albumId = firstValue(item, ["albumId", "album_id"]);
  const typeRaw = String(item?.type ?? item?.mediaType ?? item?.media_type ?? item?.contentType ?? item?.content_type ?? "").toLowerCase();
  const mediaKind = typeRaw.includes("video") || typeRaw === "2" ? "video" : "image";
  const thumbnailUrl = firstValue(item, ["thumbnailUrl", "thumbnailURL", "thumbUrl", "thumbURL", "previewUrl", "previewURL", "imageUrl", "imageURL", "url"]);
  const url = firstValue(item, ["url", "mediaUrl", "mediaURL", "downloadUrl", "downloadURL"]);
  const name = firstValue(item, ["name", "fileName", "file_name", "title"]) || `${mediaKind}-${id || "media"}`;
  const mime = firstValue(item, ["mime", "mimeType", "mime_type"]);
  const createdTime = item?.createdTime ?? item?.created_time ?? item?.timestamp ?? null;
  const obsResourceId = item?.obsResourceId && typeof item.obsResourceId === "object" ? item.obsResourceId : null;
  const resourceOid = firstValue(obsResourceId, ["oid", "objectId", "object_id"]);
  const resourceSid = firstValue(obsResourceId, ["sid", "serviceId", "service_id"]);
  return {
    id,
    albumId,
    mediaKind,
    thumbnailUrl,
    url,
    name,
    mime,
    createdTime,
    resourceOid,
    resourceSid,
    raw: jsonSafe(item),
  };
}

function extractContinuation(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["continuationToken", "continuation_token", "nextToken", "next_token", "nextContinuationToken", "next_continuation_token", "cursor", "nextCursor", "next_cursor", "pageToken", "page_token"]) {
    const found = stringValue(value[key]);
    if (found) return found;
  }
  for (const key of ["paging", "pagination", "pageInfo", "page_info"]) {
    const nested = value[key];
    const found = extractContinuation(nested);
    if (found) return found;
  }
  return null;
}

function albumMethodNames(moa) {
  if (!moa || typeof moa !== "object") return [];
  const names = new Set();
  for (const holder of [moa, Object.getPrototypeOf(moa)]) {
    if (!holder) continue;
    for (const name of Object.getOwnPropertyNames(holder)) {
      if (name !== "constructor" && typeof moa[name] === "function") names.add(name);
    }
  }
  return [...names].sort();
}

function pickMoaMethods(moa, candidates, matcher = null) {
  const names = albumMethodNames(moa);
  const exact = candidates.filter((name) => typeof moa?.[name] === "function");
  const fuzzy = names.filter((name) => !exact.includes(name) && (!matcher || matcher.test(name)));
  return [...exact, ...fuzzy];
}

function looksLikeAlbumCollection(result) {
  if (Array.isArray(result)) return true;
  if (!result || typeof result !== "object") return false;
  return ["albums", "albumList", "albumInfos", "items", "data", "results", "response"].some((key) => Array.isArray(result[key]));
}

function looksLikePhotoCollection(result) {
  if (Array.isArray(result)) return true;
  if (!result || typeof result !== "object") return false;
  return ["photos", "photoList", "albumPhotos", "contents", "contentsList", "media", "mediaList", "items", "data", "results", "response"].some((key) => Array.isArray(result[key]));
}

async function invokeMethodVariants(target, methodName, variants, accept = null) {
  const method = target?.[methodName];
  if (typeof method !== "function") throw new Error(`Moa API method ${methodName} is unavailable`);
  let lastError = null;
  for (const args of variants) {
    try {
      const value = await method.apply(target, args);
      if (!accept || accept(value)) return { value, args };
      lastError = new Error(`Moa API method ${methodName} returned an unsupported response shape`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`Moa API method ${methodName} failed`);
}

async function blobToBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value?.arrayBuffer === "function") {
    try { return Buffer.from(await value.arrayBuffer()); } catch {}
  }
  if (typeof value?.data === "string" && value.data.startsWith("data:")) {
    const comma = value.data.indexOf(",");
    if (comma > 0) try { return Buffer.from(value.data.slice(comma + 1), "base64"); } catch {}
  }
  if (value?.data != null && value.data !== value) {
    const nested = await blobToBuffer(value.data);
    if (nested) return nested;
  }
  if (value?.bytes != null && value.bytes !== value) {
    const nested = await blobToBuffer(value.bytes);
    if (nested) return nested;
  }
  if (typeof value?.base64 === "string") {
    try { return Buffer.from(value.base64, "base64"); } catch {}
  }
  return null;
}

export function makeSendReceipt(raw, { selfMid = null, chatMid = null, text = "", e2ee = true } = {}) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    id: data.id ?? data.messageId ?? data.message_id ?? null,
    createdTime: data.createdTime ?? data.created_time ?? Date.now(),
    chatMid,
    fromMid: selfMid,
    toMid: chatMid,
    text,
    contentType: data.contentType ?? "NONE",
    chunks: Array.isArray(data.chunks) ? data.chunks.length : null,
    isEdited: false,
    isMyMessage: true,
    encrypted: Boolean(e2ee),
    sent: true,
    raw: data,
  };
}

export class LineAdapter {
  constructor({
    dataDir = process.env.LINE_NATIVE_DATA_DIR ?? join(homedir(), ".local", "share", "line-native-linux"),
    device = process.env.LINE_DEVICE ?? "DESKTOPMAC",
    version = process.env.LINE_VERSION,
    linejsRuntime = null,
  } = {}) {
    this.dataDir = dataDir;
    this.device = device;
    this.version = version;
    this.storagePath = join(dataDir, "storage.json");
    this.base = null;
    this.client = null;
    this.storage = null;
    this.listening = false;
    this.tokenSaveChain = Promise.resolve();
    this.events = new Map();
    this.linejs = linejsRuntime;
    this.selfMid = null;
    this.chatIndex = new Map();
    this.userIndex = new Map();
    this.profileRequests = new Map();
    this.chatList = [];
    this.sendChain = Promise.resolve();
    this.messageObjects = new Map();
    this.mediaRequestChain = Promise.resolve();
    this.mediaCacheDir = join(this.dataDir, "media-cache");
    this.albumCacheDir = join(this.dataDir, "album-cache");
    this.albumListCache = new Map();
    this.albumPhotoCache = new Map();
    this.loginInFlight = null;
    this.loginState = "offline";
  }

  async loadLineJs() {
    if (this.linejs) return this.linejs;
    const [{ BaseClient }, { Client, TalkMessage }, { FileStorage }] = await Promise.all([
      import("@evex/linejs/base"),
      import("@evex/linejs"),
      import("@evex/linejs/storage"),
    ]);
    this.linejs = { BaseClient, Client, FileStorage, TalkMessage };
    return this.linejs;
  }

  on(name, listener) {
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(listener);
    return () => this.events.get(name)?.delete(listener);
  }

  emit(name, payload) {
    for (const listener of this.events.get(name) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        this.emit("warning", { message: `event listener failed: ${stringifyError(error)}` });
      }
    }
  }

  async prepareStorage() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.mediaCacheDir, { recursive: true, mode: 0o700 });
    await mkdir(this.albumCacheDir, { recursive: true, mode: 0o700 });
    await chmod(this.mediaCacheDir, 0o700).catch(() => {});
    await chmod(this.dataDir, 0o700).catch(() => {});
    const { FileStorage } = await this.loadLineJs();
    this.storage = new FileStorage(this.storagePath);
  }

  async saveToken(token) {
    if (typeof token !== "string" || !token) return;
    this.tokenSaveChain = this.tokenSaveChain
      .then(() => this.storage.set(TOKEN_KEY, token))
      .catch((error) => this.emit("warning", { message: `auth token persistence failed: ${stringifyError(error)}` }));
    await this.tokenSaveChain;
    await chmod(this.storagePath, 0o600).catch(() => {});
  }

  async getSavedToken() {
    const value = await this.storage.get(TOKEN_KEY);
    return typeof value === "string" && value ? value : null;
  }

  createBase() {
    const init = { device: this.device, storage: this.storage };
    if (this.version) init.version = this.version;
    const { BaseClient } = this.linejs;
    const base = new BaseClient(init);
    this.base = base;
    base.on("update:authtoken", (token) => {
      void this.saveToken(token);
      this.emit("authToken", { present: Boolean(token) });
    });
    base.on("qrcall", (url) => this.emit("qr", { url }));
    base.on("pincall", (pin) => this.emit("pin", { pin }));
    base.on("log", (entry) => this.emit("log", entry));
    return base;
  }

  async restoreSession() {
    await this.prepareStorage();
    if (this.client && this.loginState === "online") {
      try {
        const profile = await this.profile();
        return { authenticated: true, hasSavedToken: true, profile, state: this.loginState, listening: this.listening };
      } catch {
        await this.logout();
      }
    }

    const saved = await this.getSavedToken();
    if (!saved) {
      this.loginState = "offline";
      this.emit("status", { state: "offline" });
      return { authenticated: false, hasSavedToken: false, profile: null, state: this.loginState, listening: false };
    }

    try {
      const profile = await this.login({ mode: "token", token: saved });
      return { authenticated: true, hasSavedToken: true, profile, state: this.loginState, listening: this.listening };
    } catch (error) {
      // Startup restore must never unexpectedly open a QR-login flow. The
      // explicit Login button keeps the saved-token -> QR fallback.
      this.emit("status", { state: "saved-token-invalid" });
      this.emit("warning", { message: "保存済み認証情報では接続できません。ログインボタンから再認証してください。" });
      return { authenticated: false, hasSavedToken: true, profile: null, state: "offline", listening: false, error: stringifyError(error) };
    }
  }

  async login({ mode = "auto", token = null } = {}) {
    if (this.client && this.loginState === "online") {
      const existing = await this.profile();
      return existing;
    }
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      await this.prepareStorage();
      this.loginState = "preparing";
      this.emit("status", { state: "preparing" });

      const base = this.createBase();
      const cleanupFailedLogin = () => {
        this.client = null;
        this.base = null;
        this.listening = false;
        this.selfMid = null;
        this.loginState = "offline";
      };

      const runTokenLogin = async (actual, source = "token") => {
        if (!actual) throw new Error("No saved/auth token is available.");
        this.loginState = "authenticating";
        this.emit("status", { state: `${source}-login` });
        await base.loginProcess.login({ authToken: actual });
      };

      const runQrLogin = async () => {
        this.loginState = "waiting-qr";
        this.emit("status", { state: "qr-login" });
        await base.loginProcess.login({ qr: true });
      };

      try {
        if (mode === "token") {
          const actual = token || await this.getSavedToken();
          await runTokenLogin(actual, "token");
        } else if (mode === "qr") {
          await runQrLogin();
        } else if (mode === "auto") {
          const saved = await this.getSavedToken();
          if (saved) {
            try {
              await runTokenLogin(saved, "saved-token");
            } catch (error) {
              const text = stringifyError(error);
              const likelyAuthFailure = /401|403|unauthori[sz]ed|invalid.*token|expired.*token|auth.?token|login.*fail/i.test(text);
              this.emit("status", { state: likelyAuthFailure ? "saved-token-invalid" : "saved-token-failed" });
              this.emit("warning", {
                message: likelyAuthFailure
                  ? "保存済み認証情報が無効になりました。QRログインへ切り替えます。"
                  : `保存済み認証情報での接続に失敗しました。QRログインへ切り替えます: ${text}`,
              });
              await runQrLogin();
            }
          } else {
            await runQrLogin();
          }
        } else {
          throw new Error(`Unsupported login mode: ${mode}`);
        }

        this.loginState = "verifying";
        this.emit("status", { state: "verifying" });
        const { Client } = this.linejs;
        this.client = new Client(base);
        this.installClientEvents();

        if (!this.client || typeof this.client.getMyProfile !== "function") {
          throw new Error("LINE client initialization failed");
        }
        const authToken = typeof this.client.authToken === "function" ? this.client.authToken() : this.base?.authToken;
        if (typeof authToken !== "string" || !authToken) {
          throw new Error("LINE authentication completed but no auth token is available");
        }

        const profile = await this.client.getMyProfile();
        if (!profile?.mid) throw new Error("LINE login succeeded but the profile could not be verified");
        this.selfMid = profile.mid;
        if (this.base?.profile == null) this.base.profile = profile;

        this.loginState = "online";
        this.emit("ready", { profile: normalizeProfile(profile), device: this.device });
        await this.startListening();
        return normalizeProfile(profile);
      } catch (error) {
        cleanupFailedLogin();
        throw error;
      }
    })();

    try {
      return await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
  }

  installClientEvents() {
    if (!this.client) return;
    this.client.on("message", (message) => {
      const normalized = this.annotateMessageObject(message, normalizeMessage(message, { selfMid: this.selfMid }));
      this.rememberMessageObject(normalized.chatMid, message);
      void Promise.all([
        this.resolveChat(normalized.chatMid, normalized.fromMid),
        this.resolveMessageSender(normalized),
      ]).then(([chat, withSender]) => {
        this.emit("message", { ...withSender, chatName: chat?.name ?? normalized.chatMid });
      }).catch(() => this.emit("message", { ...normalized, chatName: normalized.chatMid }));
    });
    this.client.on("message:edit", (message) => {
      const normalized = this.annotateMessageObject(message, normalizeMessage(message, { selfMid: this.selfMid }));
      this.rememberMessageObject(normalized.chatMid, message);
      void Promise.all([
        this.resolveChat(normalized.chatMid, normalized.fromMid),
        this.resolveMessageSender(normalized),
      ]).then(([chat, withSender]) => {
        this.emit("message:edit", { ...withSender, chatName: chat?.name ?? normalized.chatMid });
      }).catch(() => this.emit("message:edit", { ...normalized, chatName: normalized.chatMid }));
    });
    this.client.on("log", (entry) => this.emit("log", entry));
  }

  async startListening() {
    if (!this.client || this.listening) return;
    try {
      this.client.listen({ talk: true, square: false });
      this.listening = true;
      this.loginState = "online";
      this.emit("listening", {});
    } catch (error) {
      this.listening = false;
      this.loginState = "authenticated";
      throw new Error(`LINEの受信待機を開始できませんでした: ${stringifyError(error)}`);
    }
  }

  requireClient() {
    if (!this.client) throw new Error("Not logged in.");
    return this.client;
  }

  async profile() {
    return normalizeProfile(await this.requireClient().getMyProfile());
  }

  rememberChat(chat) {
    if (!chat?.mid) return null;
    this.chatIndex.set(chat.mid, chat);
    return chat;
  }

  rememberUser(user) {
    if (!user?.mid) return null;
    this.userIndex.set(user.mid, user);
    return user;
  }

  async chats({ includeFriends = true } = {}) {
    const client = this.requireClient();
    const result = [];

    const joined = await client.fetchJoinedChats();
    for (const chat of joined) {
      const inferredType = getLineToType(client, chat?.mid ?? chat?.raw?.mid ?? chat?.raw?.chatMid ?? "");
      const n = normalizeChat(chat, {
        type: chat?.type ?? inferredType,
        kind: midTypeName(inferredType),
      });
      if (n.type == null && inferredType != null) n.type = inferredType;
      if (!n.kind || n.kind === "UNKNOWN") n.kind = midTypeName(inferredType);
      // A direct chat can arrive with only its MID in the chat record.
      // Resolve its profile lazily so the list does not depend on a single
      // undocumented object shape from linejs.
      if ((!n.name || n.name === n.mid) && n.mid && (getLineToType(client, n.mid) === 0 || n.mid.startsWith("u"))) {
        const user = await this.resolveUser(n.mid).catch(() => null);
        if (user?.displayName) n.name = user.displayName;
        if (user) {
          n.pictureStatus = user.pictureStatus;
          n.raw = { ...n.raw, ...user.raw };
        }
      }
      this.rememberChat(n);
      result.push(n);
    }

    if (includeFriends) {
      try {
        const users = await client.fetchUsers();
        for (const rawUser of users) {
          const u = normalizeUser(rawUser);
          if (!u.mid || u.mid === this.selfMid || this.chatIndex.has(u.mid)) continue;
          this.rememberUser(u);
          const direct = normalizeChat(
            { mid: u.mid, name: u.displayName ?? u.mid, raw: u.raw },
            { kind: "USER", type: 0, virtual: true, memberCount: 2 },
          );
          this.rememberChat(direct);
          result.push(direct);
        }
      } catch (error) {
        this.emit("warning", { message: `friend list unavailable: ${stringifyError(error)}` });
      }
    }

    // Keep a stable order based on LINE's returned order, but de-duplicate
    // virtual contacts that overlap a real chat entry.
    const seen = new Set();
    this.chatList = result.filter((chat) => chat?.mid && !seen.has(chat.mid) && seen.add(chat.mid));
    return this.chatList;
  }

  async friends() {
    const users = await this.requireClient().fetchUsers();
    return users.map((rawUser) => {
      const user = normalizeUser(rawUser);
      this.rememberUser(user);
      return {
        ...user,
        displayName: user.displayName ?? user.mid,
      };
    });
  }

  async resolveUser(mid) {
    if (!mid) return null;
    const cached = this.userIndex.get(mid);
    if (cached?.displayName) return cached;

    if (this.profileRequests.has(mid)) return this.profileRequests.get(mid);
    const task = (async () => {
      try {
        const user = normalizeUser(await this.requireClient().getUser(mid));
        if (user.mid) this.rememberUser(user);
        return user.mid ? user : null;
      } finally {
        this.profileRequests.delete(mid);
      }
    })();
    this.profileRequests.set(mid, task);
    return task;
  }

  async resolveChat(mid, fallbackUserMid = null) {
    if (!mid) return null;
    const cached = this.chatIndex.get(mid);
    if (cached && cached.name && cached.name !== mid) return cached;

    const client = this.requireClient();
    if ((getLineToType(client, mid) ?? null) === 0 || mid.startsWith("u")) {
      const user = await this.resolveUser(mid).catch(() => null);
      if (user) {
        const direct = normalizeChat(
          { mid, name: user.displayName ?? mid, raw: user.raw },
          { kind: "USER", type: 0, virtual: true, memberCount: 2 },
        );
        this.rememberChat(direct);
        return direct;
      }
    }

    try {
      const chat = normalizeChat(await client.getChat(mid));
      this.rememberChat(chat);
      return chat;
    } catch {}

    if (fallbackUserMid) {
      const user = await this.resolveUser(fallbackUserMid).catch(() => null);
      if (user) {
        const direct = normalizeChat(
          { mid: fallbackUserMid, name: user.displayName ?? fallbackUserMid, raw: user.raw },
          { kind: "USER", type: 0, virtual: true, memberCount: 2 },
        );
        this.rememberChat(direct);
        return direct;
      }
    }
    return cached ?? null;
  }

  async resolveMessageSender(message) {
    if (!message?.fromMid || message.isMyMessage || message.fromName) return message;
    const user = await this.resolveUser(message.fromMid).catch(() => null);
    if (!user?.displayName) return message;
    return {
      ...message,
      fromName: user.displayName,
      fromPictureStatus: user.pictureStatus ?? null,
      fromAvatarUrls: user.avatarUrls ?? [],
    };
  }

  messageKey(chatMid, messageId) {
    return `${chatMid ?? ""}:${String(messageId ?? "")}`;
  }

  rememberMessageObject(chatMid, message) {
    const raw = message?.raw ?? message ?? {};
    const id = raw.id ?? raw.messageId ?? raw.message_id ?? null;
    if (!chatMid || id == null || typeof message !== "object") return;
    this.messageObjects.set(this.messageKey(chatMid, id), message);
    // Keep memory bounded during long-running sessions. Old message objects are
    // only needed on-demand for media retrieval.
    if (this.messageObjects.size > 2000) {
      const first = this.messageObjects.keys().next().value;
      if (first) this.messageObjects.delete(first);
    }
  }

  annotateMessageObject(message, normalized) {
    const out = { ...normalized };
    try {
      if (typeof message?.getStickerURL === "function") {
        const url = message.getStickerURL();
        if (typeof url === "string" && url) {
          out.stickerUrl = url;
          out.mediaKind = "sticker";
        }
      }
    } catch {}
    const contentType = String(out.contentType ?? "").toUpperCase();
    const metadata = out.contentMetadata ?? {};
    const stickerMeta = metadata && typeof metadata === "object" && (
      metadata.STKPKGID || metadata.STKID || metadata.stkPkgId || metadata.stkId ||
      metadata.stickerId || metadata.sticker_id
    );
    if (stickerMeta || contentType === "STICKER" || Number(out.contentType) === 7) out.mediaKind = "sticker";
    if (!out.mediaKind && (contentType === "IMAGE" || Number(out.contentType) === 1)) out.mediaKind = "image";
    if (!out.mediaKind && (contentType === "VIDEO" || Number(out.contentType) === 2)) out.mediaKind = "video";
    if (!out.mediaKind && (contentType === "AUDIO" || Number(out.contentType) === 3)) out.mediaKind = "audio";
    if (!out.mediaKind && (contentType === "FILE" || Number(out.contentType) === 4)) out.mediaKind = "file";
    try {
      if (typeof message?.getFileInfo === "function") out.fileInfo = message.getFileInfo();
    } catch {}
    return out;
  }

  async findMessageObject(chatMid, messageId) {
    if (!chatMid || messageId == null) return null;
    const cached = this.messageObjects.get(this.messageKey(chatMid, messageId));
    if (cached) return cached;
    const client = this.requireClient();
    const result = await client.base.talk.getRecentMessagesV2({ messageBoxId: chatMid, messagesCount: 100 });
    const messages = Array.isArray(result) ? result : (Array.isArray(result?.messages) ? result.messages : []);
    const raw = messages.find((item) => String(item?.id ?? item?.messageId ?? item?.message_id ?? "") === String(messageId));
    if (!raw) return null;
    const TalkMessage = this.linejs?.TalkMessage;
    if (!TalkMessage?.fromRawTalk) throw new Error("LINEJS TalkMessage converter is unavailable");
    const talkMessage = await TalkMessage.fromRawTalk(raw, client);
    this.rememberMessageObject(chatMid, talkMessage);
    return talkMessage;
  }

  mediaCacheKey(chatMid, messageId, preview = true) {
    return crypto.createHash("sha256").update(`${chatMid ?? ""}:${String(messageId ?? "")}:${preview ? "preview" : "full"}`).digest("hex");
  }

  mediaCachePaths(chatMid, messageId, preview = true) {
    const key = this.mediaCacheKey(chatMid, messageId, preview);
    return {
      key,
      data: join(this.mediaCacheDir, `${key}.bin`),
      meta: join(this.mediaCacheDir, `${key}.json`),
    };
  }

  async readCachedMedia(chatMid, messageId, preview = true) {
    const paths = this.mediaCachePaths(chatMid, messageId, preview);
    try {
      const meta = JSON.parse(await readFile(paths.meta, "utf8"));
      if (meta?.unavailable) return { ...meta, cached: true };
      const data = await readFile(paths.data);
      return {
        kind: meta?.kind ?? "media",
        mime: meta?.mime ?? "application/octet-stream",
        size: data.length,
        preview: Boolean(meta?.preview),
        name: meta?.name ?? `${meta?.kind ?? "media"}-${messageId}`,
        cached: true,
        cacheKey: paths.key,
        dataUrl: `data:${meta?.mime ?? "application/octet-stream"};base64,${data.toString("base64")}`,
      };
    } catch {
      return null;
    }
  }

  async cacheMedia({ chatMid, messageId, preview, kind, mime, name, data }) {
    if (!chatMid || messageId == null || !data?.length) return null;
    const paths = this.mediaCachePaths(chatMid, messageId, preview);
    await mkdir(this.mediaCacheDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.data, data, { mode: 0o600 });
    await writeFile(paths.meta, JSON.stringify({
      version: 1,
      chatMid,
      messageId: String(messageId),
      preview: Boolean(preview),
      kind,
      mime,
      name,
      size: data.length,
      cachedAt: Date.now(),
    }), { mode: 0o600 });
    return paths.key;
  }

  async cacheUnavailableMedia({ chatMid, messageId, preview, kind, reason }) {
    if (!chatMid || messageId == null) return null;
    const paths = this.mediaCachePaths(chatMid, messageId, preview);
    await mkdir(this.mediaCacheDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.meta, JSON.stringify({
      version: 1,
      chatMid,
      messageId: String(messageId),
      preview: Boolean(preview),
      kind,
      unavailable: true,
      reason: String(reason || "メディアを取得できません"),
      cachedAt: Date.now(),
    }), { mode: 0o600 });
    return paths.key;
  }

  async messageMedia(chatMid, messageId, { preview = true, force = false } = {}) {
    const cached = await this.readCachedMedia(chatMid, messageId, preview);
    if (cached && !(force && cached.unavailable)) return cached;

    const message = await this.findMessageObject(chatMid, messageId);
    if (!message) throw new Error(`メッセージ ${messageId} が見つかりません`);

    const kind = inferMediaKind(message);
    let fileInfo = null;
    try {
      fileInfo = typeof message.getFileInfo === "function" ? message.getFileInfo() : null;
    } catch {}

    if (kind === "sticker" || typeof message.getStickerURL === "function") {
      try {
        const url = message.getStickerURL();
        if (typeof url === "string" && url) {
          // Sticker CDN URLs do not need the LINE access token. Cache a local
          // copy when possible, but keep the URL as a fallback so displaying a
          // sticker never depends on the extra download succeeding.
          try {
            const response = await fetch(url, { redirect: "follow" });
            if (response.ok) {
              const bytes = Buffer.from(await response.arrayBuffer());
              const mime = String(response.headers.get("content-type") || "image/png").split(";")[0];
              await this.cacheMedia({ chatMid, messageId, preview: true, kind: "sticker", mime, name: `sticker-${messageId}.png`, data: bytes });
              return {
                kind: "sticker", mime, size: bytes.length, preview: true,
                name: `sticker-${messageId}.png`,
                cached: true,
                dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
                url,
              };
            }
          } catch {}
          return { kind: "sticker", url, preview: true, name: `sticker-${messageId}.png` };
        }
      } catch {}
    }

    if (typeof message.getData !== "function") throw new Error("このメッセージはメディアデータを取得できません");

    const getBlob = async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await message.getData(Boolean(preview));
        } catch (error) {
          lastError = error;
          const text = stringifyError(error).toLowerCase();
          const http410 = /\b410\b/.test(text) || text.includes("gone");
          if (http410) throw Object.assign(new Error("メディアの有効期限が切れているか、LINE側で利用できません (HTTP 410)"), { code: "MEDIA_GONE", cause: error });
          const retryable = text.includes("fetch failed") || text.includes("network") || text.includes("econnreset") || text.includes("etimedout") || text.includes("socket") || text.includes("timeout");
          if (!retryable || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        }
      }
      throw lastError ?? new Error("メディア取得に失敗しました");
    };

    const blob = await new Promise((resolve, reject) => {
      const run = async () => {
        try { resolve(await getBlob()); }
        catch (error) { reject(error); }
      };
      this.mediaRequestChain = this.mediaRequestChain.then(run, run);
    }).catch(async (error) => {
      if (error?.code === "MEDIA_GONE") {
        await this.cacheUnavailableMedia({ chatMid, messageId, preview, kind, reason: error.message }).catch(() => {});
        return null;
      }
      throw error;
    });

    if (blob == null) {
      return {
        kind,
        preview: Boolean(preview),
        unavailable: true,
        reason: "メディアの有効期限が切れているか、LINE側で利用できません (HTTP 410)",
        name: fileInfo?.name || `${kind}-${messageId}`,
      };
    }
    if (!blob || typeof blob.arrayBuffer !== "function") throw new Error("メディアデータを読み込めませんでした");
    const buffer = Buffer.from(await blob.arrayBuffer());
    const mime = String(blob.type || inferMimeFromMessage(message) || "application/octet-stream");
    const maxBytes = preview ? 12 * 1024 * 1024 : 64 * 1024 * 1024;
    if (buffer.length > maxBytes) throw new Error(`メディアが大きすぎます (${Math.round(buffer.length / 1024 / 1024)} MiB、上限 ${maxBytes / 1024 / 1024} MiB)`);
    const name = fileInfo?.name || `${kind}-${messageId}`;
    await this.cacheMedia({ chatMid, messageId, preview, kind, mime, name, data: buffer }).catch(() => {});
    return {
      kind,
      mime,
      size: buffer.length,
      preview: Boolean(preview),
      name,
      expiresAt: fileInfo?.expire instanceof Date ? fileInfo.expire.toISOString() : (fileInfo?.expire ?? null),
      cached: true,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
    };
  }

  async sendSticker(mid, { packageId, stickerId, version = "100" } = {}) {
    if (!mid) throw new Error("chat MID is required");
    const pkg = String(packageId ?? "").trim();
    const stk = String(stickerId ?? "").trim();
    const ver = String(version ?? "100").trim() || "100";
    if (!/^\d+$/.test(pkg) || !/^\d+$/.test(stk) || !/^\d+$/.test(ver)) {
      throw new Error("スタンプの STKPKGID / STKID / STKVER は数字で指定してください");
    }
    const client = this.requireClient();
    const run = async () => {
      // LINEJS exposes the raw Talk sendMessage contentType/contentMetadata
      // surface. This uses the classic sticker reference fields. Sticker E2EE
      // encryption is not implemented in this project yet, so this call is
      // deliberately marked e2ee:false rather than silently downgrading an
      // E2EE text path.
      const raw = await client.base.talk.sendMessage({
        to: mid,
        text: "",
        contentType: 7,
        contentMetadata: {
          STKVER: ver,
          STKPKGID: pkg,
          STKID: stk,
        },
        e2ee: false,
      });
      return {
        ...makeSendReceipt(raw, { selfMid: this.selfMid, chatMid: mid, text: "", e2ee: false }),
        mediaKind: "sticker",
        sticker: { packageId: pkg, stickerId: stk, version: ver },
      };
    };
    const result = this.sendChain.then(run, run);
    this.sendChain = result.catch(() => undefined);
    return result;
  }

  async uploadTalkObject({ oid, data, filename, mime, uploadType, size }) {
    const client = this.requireClient();
    const token = typeof client.authToken === "function" ? client.authToken() : (client?.base?.authToken ?? await this.getSavedToken());
    if (!token) throw new Error("LINE auth token is unavailable for media upload");

    let application = null;
    for (const holder of [client?.base?.headers, client?.base?.defaultHeaders, client?.base?._headers, client?.base?.options?.headers]) {
      application = getHeader(holder, "x-line-application");
      if (application) break;
    }
    if (!application && typeof client?.base?.getHeaders === "function") {
      try { application = getHeader(await client.base.getHeaders(), "x-line-application"); } catch {}
    }
    if (!application) {
      application = `${this.device}\t${this.version || "3.4.2"}\t${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"}`;
    }

    const params = JSON.stringify({
      name: String(filename || "attachment"),
      oid: String(oid),
      size: Number(size ?? data.length),
      type: String(uploadType || "file"),
      ver: "1.0",
    });
    const endpoints = [
      "https://os.line.naver.jp/talk/m/upload.nhn",
      "https://obs-de.line-apps.com/talk/m/upload.nhn",
    ];
    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const form = new FormData();
        form.append("params", params);
        form.append("file", new Blob([data], { type: mime || "application/octet-stream" }), String(filename || "attachment"));
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "X-Line-Access": String(token),
            "X-Line-Application": application,
          },
          body: form,
          redirect: "follow",
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`LINE media upload HTTP ${response.status}: ${body.slice(0, 240)}`);
        return { endpoint, status: response.status, body: body.slice(0, 1000) };
      } catch (error) {
        lastError = error;
        const reason = stringifyError(error);
        if (!/fetch failed|network|econnreset|etimedout|socket|HTTP 5\d\d/i.test(reason) || endpoint === endpoints.at(-1)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw lastError ?? new Error("LINE media upload failed");
  }

  async sendFile(mid, filePath, { caption = "" } = {}) {
    if (!mid) throw new Error("chat MID is required");
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("file path is required");
    const client = this.requireClient();
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("選択したパスはファイルではありません");
    const maxBytes = 64 * 1024 * 1024;
    if (info.size > maxBytes) throw new Error(`ファイルが大きすぎます (${Math.round(info.size / 1024 / 1024)} MiB、上限 ${maxBytes / 1024 / 1024} MiB)`);

    const filename = filePath.split(/[\\/]/).pop() || "attachment";
    const mime = ({
      jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",bmp:"image/bmp",
      mp4:"video/mp4",m4v:"video/mp4",mov:"video/quicktime",webm:"video/webm",mkv:"video/x-matroska",
      mp3:"audio/mpeg",m4a:"audio/mp4",aac:"audio/aac",wav:"audio/wav",ogg:"audio/ogg",opus:"audio/opus",flac:"audio/flac",
      pdf:"application/pdf",txt:"text/plain",zip:"application/zip","7z":"application/x-7z-compressed",tar:"application/x-tar",gz:"application/gzip",
    })[filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : ""] || "application/octet-stream";
    const spec = inferOutgoingMediaSpec(filename, mime);
    const data = await readFile(filePath);
    this.emit("status", { state: `ファイルを送信中: ${filename}` });

    const run = async () => {
      // LINEJS exposes Talk sendMessage(contentType/metadata), but not a high-level
      // Talk object upload helper. Reserve the message ID first, then upload the
      // bytes to the Talk object store using the legacy multipart flow.
      const raw = await client.base.talk.sendMessage({
        to: mid,
        text: "",
        contentType: spec.contentType,
        e2ee: false,
      });
      const oid = raw?.id ?? raw?.messageId ?? raw?.message_id;
      if (oid == null) throw new Error("LINE did not return a message ID for the attachment");
      await this.uploadTalkObject({ oid, data, filename, mime, uploadType: spec.uploadType, size: info.size });
      return {
        ...makeSendReceipt(raw, { selfMid: this.selfMid, chatMid: mid, text: String(caption || ""), e2ee: false }),
        mediaKind: spec.mediaKind,
        fileName: filename,
        fileSize: info.size,
        mime,
        attachment: true,
      };
    };
    const result = this.sendChain.then(run, run);
    this.sendChain = result.catch(() => undefined);
    return result;
  }

  moaService() {
    const client = this.requireClient();
    const moa = client?.base?.moa;
    if (!moa) throw new Error("LINEJS Moa/Album service is unavailable in this session");
    return moa;
  }

  moaDiagnostics() {
    let methods = [];
    try { methods = albumMethodNames(this.client?.base?.moa); } catch {}
    return { available: methods.length > 0, methods };
  }

  async albums(chatMid, { force = false } = {}) {
    if (!chatMid) throw new Error("chat MID is required");
    const moa = this.moaService();
    const cacheKey = String(chatMid);
    if (force) this.albumListCache.delete(cacheKey);
    if (this.albumListCache.has(cacheKey)) return this.albumListCache.get(cacheKey);

    const all = [];
    let cursor = "";
    const seen = new Set();
    for (let page = 0; page < 100; page += 1) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const response = await moa.getAlbums({ cursor });
      const result = response?.result ?? response ?? {};
      const entries = Array.isArray(result) ? result : (Array.isArray(result?.albums) ? result.albums : []);
      all.push(...entries);
      const next = String(result?.nextCursor ?? result?.cursor ?? "");
      if (!next || next === cursor || result?.hasMore === false) break;
      cursor = next;
    }

    const list = all.map((raw) => normalizeAlbum(raw))
      .filter((album) => album.id)
      .filter((album) => {
        const raw = album.raw ?? {};
        const ownerChat = raw.chatId ?? raw.chat_id ?? raw.messageBoxId ?? raw.message_box_id ?? raw.to ?? null;
        return !ownerChat || String(ownerChat) === String(chatMid);
      });
    this.albumListCache.set(cacheKey, list);
    return list;
  }

  async albumPhotos(chatMid, albumId, { continuationToken = null, limit = 100, force = false } = {}) {
    if (!chatMid || !albumId) throw new Error("chat MID and album ID are required");
    const moa = this.moaService();
    const cacheKey = `${chatMid}:${albumId}:${continuationToken || "first"}:${limit}`;
    if (force) this.albumPhotoCache.delete(cacheKey);
    const cached = this.albumPhotoCache.get(cacheKey);
    if (cached) return cached;

    const response = await moa.getPhotos({
      chatId: chatMid,
      albumId: String(albumId),
      cursor: continuationToken || "",
      pageSize: Math.max(1, Math.min(Number(limit) || 100, 100)),
    });
    const result = response?.result ?? response ?? {};
    const rawPhotos = Array.isArray(result) ? result : (Array.isArray(result?.photos) ? result.photos : []);
    const photos = rawPhotos.map(normalizeAlbumPhoto).filter((photo) => photo.id);
    const nextCursor = result?.nextCursor ?? result?.cursor ?? null;
    const normalized = { albumId: String(albumId), photos, continuationToken: nextCursor ? String(nextCursor) : null, hasMore: Boolean(nextCursor) };
    this.albumPhotoCache.set(cacheKey, normalized);
    return normalized;
  }

  albumMediaCachePaths(chatMid, albumId, mediaId) {
    const key = crypto.createHash("sha256").update(`${chatMid}:${albumId}:${mediaId}`).digest("hex");
    return {
      key,
      data: join(this.albumCacheDir, `${key}.bin`),
      meta: join(this.albumCacheDir, `${key}.json`),
    };
  }

  async readCachedAlbumMedia(chatMid, albumId, mediaId) {
    const paths = this.albumMediaCachePaths(chatMid, albumId, mediaId);
    try {
      const meta = JSON.parse(await readFile(paths.meta, "utf8"));
      const data = await readFile(paths.data);
      return {
        ...meta,
        cached: true,
        size: data.length,
        dataUrl: `data:${meta?.mime || "application/octet-stream"};base64,${data.toString("base64")}`,
      };
    } catch {
      return null;
    }
  }

  async cacheAlbumMedia(chatMid, albumId, mediaId, { kind = "image", mime = "application/octet-stream", name = "album-media", data }) {
    if (!chatMid || !albumId || !mediaId || !data?.length) return null;
    await mkdir(this.albumCacheDir, { recursive: true, mode: 0o700 });
    const paths = this.albumMediaCachePaths(chatMid, albumId, mediaId);
    await writeFile(paths.data, data, { mode: 0o600 });
    await writeFile(paths.meta, JSON.stringify({
      version: 1, chatMid, albumId: String(albumId), mediaId: String(mediaId), kind, mime, name, size: data.length, cachedAt: Date.now(),
    }), { mode: 0o600 });
    return paths.key;
  }

  async albumMedia(chatMid, albumId, media, { preview = true } = {}) {
    const mediaId = typeof media === "string" ? media : (media?.id ?? media?.mediaId ?? media?.photoId ?? media?.contentId ?? media?.oid);
    if (!chatMid || !albumId || !mediaId) throw new Error("chat MID, album ID and media ID are required");
    const cached = await this.readCachedAlbumMedia(chatMid, albumId, mediaId);
    if (cached) return cached;

    let photo = typeof media === "object" && media ? media : {};
    // The GUI normally sends the normalized photo. For older callers, recover
    // the resource identifiers from the adapter's paginated album-photo cache.
    if (!photo.resourceOid && !photo?.raw?.obsResourceId?.oid) {
      for (const [key, value] of this.albumPhotoCache.entries()) {
        if (!String(key).startsWith(`${chatMid}:${albumId}:`)) continue;
        for (const candidate of value?.photos ?? []) {
          if (String(candidate?.id ?? "") === String(mediaId)) {
            photo = { ...candidate, ...photo };
            break;
          }
        }
        if (photo.resourceOid || photo?.raw?.obsResourceId?.oid) break;
      }
    }

    const resource = photo?.raw?.obsResourceId ?? photo?.obsResourceId ?? {};
    const resourceOid = photo?.resourceOid ?? resource?.oid ?? photo?.oid ?? null;
    const resourceSid = photo?.resourceSid ?? resource?.sid ?? null;
    const isVideo = String(photo.mediaKind || "").toLowerCase() === "video" || String(resourceSid || "").toLowerCase() === "v";
    const prefix = isVideo ? "album/v" : "album/a";
    const oid = String(resourceOid || mediaId);
    const moa = this.moaService();

    const download = async () => {
      const args = { chatId: chatMid, albumId: String(albumId), oid };
      if (prefix) args.prefix = prefix;
      return moa.downloadPhoto(args);
    };

    let bytesValue;
    try {
      bytesValue = await download();
    } catch (error) {
      // The official Moa service documents explicit channel-token reset on
      // token rejection/expiry. Retry once after clearing that session cache.
      const detail = stringifyError(error);
      const status = Number(error?.status ?? error?.data?.status ?? error?.response?.status ?? 0);
      const retryable = [401, 403].includes(status) || /401|403|channel.?token|unauthori[sz]ed|forbidden|token.*expired/i.test(detail);
      if (!retryable || typeof moa.clearAlbumChannelToken !== "function") throw error;
      await moa.clearAlbumChannelToken().catch(() => {});
      bytesValue = await download();
    }

    const bytes = await blobToBuffer(bytesValue);
    if (!bytes?.length) {
      throw new Error(`アルバムメディアのデータを取得できませんでした (oid=${oid}, kind=${isVideo ? "video" : "image"})`);
    }
    const kind = isVideo ? "video" : "image";
    const mime = String(photo.mime || (isVideo ? "video/mp4" : "image/jpeg"));
    const name = String(photo.name || `${kind}-${mediaId}.${isVideo ? "mp4" : "jpg"}`);
    await this.cacheAlbumMedia(chatMid, albumId, mediaId, { kind, mime, name, data: bytes });
    return { kind, mime, name, size: bytes.length, preview: Boolean(preview), cached: true, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
  }

  async history(mid, limit = 50) {
    if (!mid) throw new Error("chat MID is required");
    const client = this.requireClient();
    const result = await client.base.talk.getRecentMessagesV2({
      messageBoxId: mid,
      messagesCount: limit,
    });
    const messages = Array.isArray(result) ? result : (Array.isArray(result?.messages) ? result.messages : []);
    const TalkMessage = this.linejs?.TalkMessage;
    if (!TalkMessage?.fromRawTalk) throw new Error("LINEJS TalkMessage converter is unavailable");
    const normalized = await Promise.all(messages.map(async (message) => {
      const talkMessage = await TalkMessage.fromRawTalk(message, client);
      this.rememberMessageObject(mid, talkMessage);
      const value = this.annotateMessageObject(talkMessage, normalizeMessage(talkMessage, {
        selfMid: this.selfMid,
        chatMid: mid,
      }));
      return this.resolveMessageSender(value);
    }));
    return sortMessagesChronologically(normalized);
  }

  async preflightE2EE(mid) {
    if (!mid) throw new Error("chat MID is required");
    const client = this.requireClient();
    const toType = getLineToType(client, mid);
    if (toType === 0) {
      return { mid, midType: 0, midTypeName: "USER", mode: "direct-user", ok: true };
    }
    if (toType !== 1 && toType !== 2) {
      throw new Error(`Unsupported/unknown MID type for ${mid}: ${toType ?? "UNKNOWN"}`);
    }
    const material = await this.getCurrentGroupKeyMaterial(mid);
    return {
      mid,
      midType: toType,
      midTypeName: midTypeName(toType),
      mode: "direct-current-group-key",
      groupKeyId: material.groupKeyId,
      receiverKeyId: material.receiverKeyId,
      creator: material.creator,
      creatorKeyId: material.creatorKeyId,
      usable: true,
      ok: true,
    };
  }

  async getCurrentGroupKeyMaterial(mid) {
    const client = this.requireClient();
    const type = getLineToType(client, mid);
    if (type !== 1 && type !== 2) {
      throw new Error(`Current group key is only applicable to ROOM/GROUP chats: ${mid}`);
    }
    const e2ee = client.base?.e2ee;
    const talk = client.base?.talk;
    if (!e2ee || !talk) throw new Error("LINEJS E2EE/Talk service is unavailable.");

    const shared = await talk.getLastE2EEGroupSharedKey({
      keyVersion: 2,
      chatMid: mid,
    });
    if (!shared?.groupKeyId || !shared?.creator || shared?.receiverKeyId == null) {
      throw new Error(`LINE did not return a complete current group key for ${mid}.`);
    }

    const receiverKeyId = Number(shared.receiverKeyId);
    if (!Number.isInteger(receiverKeyId)) {
      throw new Error(`Invalid E2EE receiver key ID for ${mid}: ${shared.receiverKeyId}`);
    }

    const selfKey = await e2ee.getE2EESelfKeyDataByKeyId(receiverKeyId);
    if (!selfKey?.privKey || !selfKey?.pubKey) {
      throw new Error(`Local E2EE private/public key ${receiverKeyId} is unavailable.`);
    }
    const selfPriv = Buffer.from(selfKey.privKey, "base64");
    const selfPub = Buffer.from(selfKey.pubKey, "base64");
    if (selfPriv.length !== 32 || selfPub.length !== 32) {
      throw new Error(`Local E2EE key ${receiverKeyId} is malformed.`);
    }
    if (typeof e2ee.verifyE2EEKeyPair === "function" && !e2ee.verifyE2EEKeyPair(selfPriv, selfPub)) {
      throw new Error(`Local E2EE key ${receiverKeyId} failed self key-pair verification.`);
    }

    const publicKeys = await talk.getLastE2EEPublicKeys({ chatMid: mid });
    const creatorEntry = publicKeys?.[shared.creator];
    if (!creatorEntry?.keyData) {
      throw new Error(`Creator public key ${shared.creator} is unavailable for current group key ${shared.groupKeyId}.`);
    }
    const creatorKeyId = Number(shared.creatorKeyId ?? creatorEntry.keyId);
    if (!Number.isInteger(creatorKeyId)) {
      throw new Error(`Invalid E2EE creator key ID for ${mid}: ${shared.creatorKeyId ?? creatorEntry.keyId}`);
    }
    if (Number(creatorEntry.keyId) !== creatorKeyId) {
      throw new Error(`Creator key mismatch: group key expects ${creatorKeyId}, server public-key list returned ${creatorEntry.keyId}.`);
    }

    const creatorPub = Buffer.from(creatorEntry.keyData);
    if (creatorPub.length !== 32) throw new Error(`Creator public key ${creatorKeyId} is malformed.`);

    const encryptedSharedKey = Buffer.from(shared.encryptedSharedKey ?? []);
    if (!encryptedSharedKey.length || encryptedSharedKey.length % 16 !== 0) {
      throw new Error(`Encrypted group key payload is malformed (length=${encryptedSharedKey.length}).`);
    }

    const ecdh = Buffer.from(e2ee.generateSharedSecret(selfPriv, creatorPub));
    const aesKey = e2ee.getSHA256Sum(ecdh, "Key");
    const aesIv = e2ee.xor(e2ee.getSHA256Sum(ecdh, "IV"));
    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesIv);
    const privateKey = Buffer.concat([decipher.update(encryptedSharedKey), decipher.final()]);
    if (privateKey.length !== 32) {
      throw new Error(`Unwrapped group private key has invalid length ${privateKey.length}.`);
    }

    const groupKeyId = Number(shared.groupKeyId);
    const material = {
      mid,
      groupKeyId,
      creator: shared.creator,
      creatorKeyId,
      receiverKeyId,
      selfKeyId: Number(selfKey.keyId ?? receiverKeyId),
      selfPrivateKey: selfPriv,
      selfPublicKey: selfPub,
      groupPrivateKey: privateKey,
    };
    // Match linejs's own cache schema so subsequent library calls can reuse the
    // exact same group-key generation without forcing a recreation request.
    const cacheValue = JSON.stringify({
      keyId: groupKeyId,
      privKey: privateKey.toString("base64"),
    });
    await client.base.storage.set(`e2eeGroupKeys:${mid}:${groupKeyId}`, cacheValue);
    await client.base.storage.set(`e2eeGroupKeys:${mid}`, cacheValue);
    return material;
  }

  async sendTextDirectCurrentGroupKey(mid, text) {
    const client = this.requireClient();
    const type = getLineToType(client, mid);
    if (type !== 1 && type !== 2) throw new Error("direct-current-group-key send is only for ROOM/GROUP");
    const material = await this.getCurrentGroupKeyMaterial(mid);
    const e2ee = client.base?.e2ee;
    const selfKey = await e2ee.getE2EESelfKeyData(this.selfMid);
    if (!selfKey?.privKey || !selfKey?.pubKey) throw new Error("Local self E2EE key is unavailable.");
    const groupKeyData = e2ee.generateSharedSecret(
      material.groupPrivateKey,
      Buffer.from(selfKey.pubKey, "base64"),
    );
    const senderKeyId = Number(selfKey.keyId ?? material.selfKeyId);
    const chunks = e2ee.encryptE2EETextMessage(
      senderKeyId,
      material.groupKeyId,
      Buffer.from(groupKeyData),
      2,
      text,
      mid,
      this.selfMid,
    );
    const raw = await client.base.talk.sendMessage({
      to: mid,
      contentType: "NONE",
      contentMetadata: {
        e2eeVersion: "2",
        contentType: "0",
        e2eeMark: "2",
      },
      e2ee: true,
      chunks,
    });
    // Do NOT pass the send response through TalkMessage.fromRawTalk().
    // The /S4 send response is an acknowledgement-shaped Message in some
    // LINE server paths and may omit contentMetadata. linejs's converter
    // assumes contentMetadata is always present and can throw after the
    // server has already accepted the message. The live event stream is the
    // authoritative fully-populated message; return a local send receipt here.
    return makeSendReceipt(raw, { selfMid: this.selfMid, chatMid: mid, text, e2ee: true });
  }

  async chatInfo(mid) {
    if (!mid) throw new Error("chat MID is required");
    const client = this.requireClient();
    const toType = getLineToType(client, mid);

    // 1:1 USER talks are represented by a contact profile in some linejs
    // server paths rather than a fully populated Chat object. Prefer the
    // already-working profile resolver for those MIDs.
    let chat = null;
    if (toType === 0 || mid.startsWith("u")) {
      const user = await this.resolveUser(mid).catch(() => null);
      if (user) {
        chat = normalizeChat(
          { mid, name: user.displayName ?? mid, raw: user.raw },
          { kind: "USER", type: 0, virtual: true, memberCount: 2 },
        );
        this.rememberChat(chat);
      }
    }
    if (!chat) {
      chat = await client.getChat(mid);
    }
    let e2eeSelf = null;
    try {
      const key = await client.base.e2ee.getE2EESelfKeyData(this.selfMid);
      e2eeSelf = {
        keyId: key?.keyId ?? null,
        hasPrivateKey: Boolean(key?.privKey),
        hasPublicKey: Boolean(key?.pubKey),
      };
    } catch (error) {
      e2eeSelf = { error: stringifyError(error) };
    }
    let publicKeyCount = null;
    let groupKeys = null;
    let groupKeyError = null;
    if (Number(toType) !== 0) {
      try {
        const keys = await client.base.talk.getLastE2EEPublicKeys({ chatMid: mid });
        publicKeyCount = keys && typeof keys === "object" ? Object.keys(keys).length : null;
      } catch (error) {
        groupKeyError = { code: errorCode(error), reason: errorReason(error) };
      }
      try {
        const key = await client.base.talk.getLastE2EEGroupSharedKey({ keyVersion: 2, chatMid: mid });
        groupKeys = {
          present: Boolean(key),
          keyId: key?.groupKeyId ?? null,
          creator: key?.creator ?? null,
          receiverKeyId: key?.receiverKeyId ?? null,
        };
      } catch (error) {
        groupKeyError = { code: errorCode(error), reason: errorReason(error) };
      }
    }
    const normalized = normalizeChat(chat, {
      type: chat?.type ?? toType,
      kind: midTypeName(toType),
    });
    if (normalized.type == null && toType != null) normalized.type = toType;
    if (!normalized.kind || normalized.kind === "UNKNOWN") normalized.kind = midTypeName(toType);

    // Group/room chat objects may expose member MIDs without embedding the
    // corresponding contact profiles. Resolve a bounded number in parallel so
    // the info pane can still show human-readable member names.
    let memberNames = normalized.memberNames;
    let members = Array.isArray(chat?.members) ? chat.members.map((member) => ({
      mid: member?.mid ?? member?.raw?.mid ?? null,
      name: userDisplayName(member) ?? member?.name ?? member?.displayName ?? null,
      pictureStatus: member?.pictureStatus ?? member?.raw?.pictureStatus ?? null,
      avatarUrls: member?.avatarUrls ?? [],
    })).filter((member) => member.mid) : [];
    if (!members.length && Number(toType) !== 0) {
      const rawMemberMids = chat?.memberMids ?? chat?.member_mids ?? chat?.raw?.memberMids ?? chat?.raw?.member_mids;
      if (Array.isArray(rawMemberMids) && rawMemberMids.length) {
        const resolved = [];
        for (let i = 0; i < rawMemberMids.length; i += 5) {
          const batch = rawMemberMids.slice(i, i + 5);
          const values = await Promise.all(batch.map((memberMid) => this.resolveUser(memberMid).catch(() => null)));
          for (let j = 0; j < batch.length; j++) {
            const user = values[j];
            resolved.push({
              mid: batch[j],
              name: user?.displayName ?? batch[j],
              pictureStatus: user?.pictureStatus ?? null,
              avatarUrls: user?.avatarUrls ?? [],
            });
          }
        }
        members = resolved;
      }
    }
    if (!memberNames.length && members.length) memberNames = members.map((member) => member.name).filter(Boolean);

    return {
      mid,
      name: normalized.name,
      type: normalized.type,
      midType: Number.isFinite(Number(toType)) ? Number(toType) : null,
      midTypeName: midTypeName(toType),
      memberCount: normalized.memberCount ?? (members.length || null) ?? (Array.isArray(chat?.memberMids) ? chat.memberMids.length : null),
      memberNames,
      members,
      pictureStatus: normalized.pictureStatus ?? null,
      avatarUrls: normalized.avatarUrls ?? [],
      e2eeSelf,
      registeredE2EEPublicKeyCount: publicKeyCount,
      groupKey: groupKeys,
      groupKeyError,
      raw: normalized.raw,
    };
  }

  async sendText(mid, text, { e2ee = true } = {}) {
    if (!mid) throw new Error("chat MID is required");
    if (typeof text !== "string" || !text) throw new Error("message text is required");
    const client = this.requireClient();
    if (!e2ee) return this.sendPlainText(mid, text);

    const run = async () => {
      const type = getLineToType(client, mid);
      if (type === 1 || type === 2) {
        try {
          // Use the explicitly unwrapped current group key rather than allowing
          // linejs 3.4.2 to enter its recreation path when the cached generation
          // is missing. This remains fully E2EE and never downgrades to plaintext.
          this.emit("e2eeDirect", { chatMid: mid, mode: "current-group-key" });
          return await this.sendTextDirectCurrentGroupKey(mid, text);
        } catch (error) {
          const code = errorCode(error);
          const reason = errorReason(error);
          throw new Error(
            `Direct current-group-key E2EE send failed for ${mid} (MID type: ${midTypeName(type)}). ` +
            `No plaintext fallback was attempted. ` +
            `Underlying: ${code || reason || stringifyError(error)}`,
            { cause: error },
          );
        }
      }

      // Use the base TalkService directly for USER chats too. Chat.sendMessage()
      // wraps the response in TalkMessage.fromRawTalk(), which can fail after
      // an otherwise successful /S4 request when contentMetadata is omitted
      // from the acknowledgement.
      const raw = await client.base.talk.sendMessage({
        to: mid,
        text,
        e2ee: true,
      });
      return makeSendReceipt(raw, { selfMid: this.selfMid, chatMid: mid, text, e2ee: true });
    };

    const result = this.sendChain.then(run, run);
    this.sendChain = result.catch(() => undefined);
    return result;
  }

  async sendPlainText(mid, text) {
    if (!mid) throw new Error("chat MID is required");
    if (typeof text !== "string" || !text) throw new Error("message text is required");
    const client = this.requireClient();
    // Explicitly use the public compact plaintext endpoint. This is NOT a
    // fallback from an E2EE failure; the user must invoke send-plain.
    if (typeof client.base.talk.sendCompactMessage !== "function") {
      throw new Error("LINEJS compact message API is unavailable");
    }
    const result = await client.base.talk.sendCompactMessage({ to: mid, text, e2ee: false });
    return {
      id: result?.messageId != null ? String(result.messageId) : null,
      createdTime: result?.createdTime ?? Date.now(),
      chatMid: mid,
      fromMid: this.selfMid,
      toMid: mid,
      text,
      contentType: "NONE",
      chunks: null,
      isEdited: false,
      isMyMessage: true,
      encrypted: false,
      raw: result ?? null,
    };
  }

  async markRead(mid) {
    if (!mid) throw new Error("chat MID is required");
    const client = this.requireClient();
    const result = await client.base.talk.getRecentMessagesV2({ messageBoxId: mid, messagesCount: 1 });
    const messages = Array.isArray(result) ? result : (Array.isArray(result?.messages) ? result.messages : []);
    const raw = messages.at(-1);
    if (!raw) return false;
    const TalkMessage = this.linejs?.TalkMessage;
    if (!TalkMessage?.fromRawTalk) throw new Error("LINEJS TalkMessage converter is unavailable");
    const message = await TalkMessage.fromRawTalk(raw, client);
    if (typeof message.read !== "function") return false;
    await message.read();
    return true;
  }

  async exportDiagnostics() {
    return {
      dataDir: this.dataDir,
      storagePath: this.storagePath,
      device: this.device,
      version: this.version ?? null,
      node: process.version,
      linejsLoaded: true,
      loggedIn: Boolean(this.client),
      loginState: this.loginState,
      listening: this.listening,
      authTokenPresent: Boolean(this.client && (typeof this.client.authToken === "function" ? this.client.authToken() : this.base?.authToken)),
      cachedChats: this.chatIndex.size,
      cachedFriends: this.userIndex.size,
      mediaCacheDir: this.mediaCacheDir,
      albumCacheDir: this.albumCacheDir,
      moa: this.moaDiagnostics(),
    };
  }

  async logout({ clearToken = false } = {}) {
    this.listening = false;
    this.loginState = "offline";
    this.client = null;
    this.base = null;
    this.selfMid = null;
    this.chatIndex.clear();
    this.userIndex.clear();
    this.profileRequests.clear();
    this.chatList = [];
    this.messageObjects.clear();
    this.albumListCache.clear();
    this.albumPhotoCache.clear();
    if (clearToken && this.storage) await this.storage.delete(TOKEN_KEY).catch(() => {});
  }
}

function inferMediaKind(message) {
  const raw = message?.raw ?? message ?? {};
  const typeValue = raw.contentType ?? raw.content_type ?? "";
  const type = String(typeValue).toUpperCase();
  if (type === "IMAGE" || Number(typeValue) === 1) return "image";
  if (type === "VIDEO" || Number(typeValue) === 2) return "video";
  if (type === "AUDIO" || Number(typeValue) === 3) return "audio";
  if (type === "STICKER" || Number(typeValue) === 7) return "sticker";
  if (type === "FILE" || Number(typeValue) === 14 || Number(typeValue) === 4) return "file";
  return "media";
}

function inferMimeFromMessage(message) {
  const info = message?.getFileInfo?.();
  const name = String(info?.name ?? "");
  const ext = name.toLowerCase().split(".").pop();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", pdf: "application/pdf" };
  return map[ext] ?? null;
}

async function normalizeMessageFromTalkMessage(TalkMessage, raw, client, options) {
  return normalizeMessage(await TalkMessage.fromRawTalk(raw, client), options);
}

export async function showQrAnsi(url) {
  return new Promise((resolve) => {
    const child = spawn("qrencode", ["-t", "ANSIUTF8", url], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}
