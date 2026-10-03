import { mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

import { normalizeChat, normalizeMessage, normalizeProfile } from "./normalize.mjs";

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

function getLineToType(client, mid) {
  const type = client?.base?.getToType?.(mid);
  return Number.isFinite(Number(type)) ? Number(type) : null;
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
    this.chatList = [];
    this.sendChain = Promise.resolve();
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

  async login({ mode = "auto", token = null } = {}) {
    await this.prepareStorage();
    const base = this.createBase();
    if (mode === "token") {
      const actual = token || await this.getSavedToken();
      if (!actual) throw new Error("No saved/auth token is available.");
      await base.loginProcess.login({ authToken: actual });
    } else if (mode === "qr") {
      await base.loginProcess.login({ qr: true });
    } else if (mode === "auto") {
      const saved = await this.getSavedToken();
      if (saved) {
        this.emit("status", { state: "token-login" });
        try {
          await base.loginProcess.login({ authToken: saved });
        } catch (error) {
          throw new Error(`saved auth token login failed: ${stringifyError(error)}. Run "login qr" to re-authenticate.`);
        }
      } else {
        await base.loginProcess.login({ qr: true });
      }
    } else {
      throw new Error(`Unsupported login mode: ${mode}`);
    }

    const { Client } = this.linejs;
    this.client = new Client(base);
    this.installClientEvents();
    const profile = await this.client.getMyProfile();
    this.selfMid = profile?.mid ?? null;
    if (this.base?.profile == null && this.selfMid) this.base.profile = profile;
    this.emit("ready", { profile: normalizeProfile(profile), device: this.device });
    await this.startListening();
    return normalizeProfile(profile);
  }

  installClientEvents() {
    if (!this.client) return;
    this.client.on("message", (message) => {
      const normalized = normalizeMessage(message, { selfMid: this.selfMid });
      void this.resolveChat(normalized.chatMid, normalized.fromMid).then((chat) => {
        this.emit("message", { ...normalized, chatName: chat?.name ?? normalized.chatMid });
      }).catch(() => this.emit("message", { ...normalized, chatName: normalized.chatMid }));
    });
    this.client.on("message:edit", (message) => {
      const normalized = normalizeMessage(message, { selfMid: this.selfMid });
      void this.resolveChat(normalized.chatMid, normalized.fromMid).then((chat) => {
        this.emit("message:edit", { ...normalized, chatName: chat?.name ?? normalized.chatMid });
      }).catch(() => this.emit("message:edit", { ...normalized, chatName: normalized.chatMid }));
    });
    this.client.on("log", (entry) => this.emit("log", entry));
  }

  async startListening() {
    if (!this.client || this.listening) return;
    this.listening = true;
    this.client.listen({ talk: true, square: false });
    this.emit("listening", {});
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
      const n = normalizeChat(chat);
      this.rememberChat(n);
      result.push(n);
    }

    if (includeFriends) {
      try {
        const users = await client.fetchUsers();
        for (const user of users) {
          const u = this.rememberUser({
            mid: user.mid,
            name: user.raw?.displayName ?? user.raw?.display_name ?? user.mid,
            raw: user.raw,
          });
          if (!u || u.mid === this.selfMid || this.chatIndex.has(u.mid)) continue;
          const direct = normalizeChat(
            { mid: u.mid, name: u.name, raw: u.raw },
            { kind: "USER", type: 0, virtual: true },
          );
          this.rememberChat(direct);
          result.push(direct);
        }
      } catch (error) {
        this.emit("warning", { message: `friend list unavailable: ${stringifyError(error)}` });
      }
    }

    this.chatList = result;
    return result;
  }

  async friends() {
    const users = await this.requireClient().fetchUsers();
    return users.map((user) => ({
      mid: user.mid,
      displayName: user.raw?.displayName ?? user.raw?.display_name ?? user.mid,
      pictureStatus: user.raw?.pictureStatus ?? null,
      statusMessage: user.raw?.statusMessage ?? null,
      raw: user.raw,
    }));
  }

  async resolveChat(mid, fallbackUserMid = null) {
    if (!mid) return null;
    if (this.chatIndex.has(mid)) return this.chatIndex.get(mid);
    const client = this.requireClient();

    // USER MIDs can be represented by a friend/contact even when no chat row
    // was returned by getAllChatMids().
    if ((getLineToType(client, mid) ?? null) === 0 || mid.startsWith("u")) {
      try {
        const user = await client.getUser(mid);
        const name = user.raw?.displayName ?? user.raw?.display_name ?? mid;
        const direct = normalizeChat({ mid, name, raw: user.raw }, { kind: "USER", type: 0, virtual: true });
        this.rememberChat(direct);
        return direct;
      } catch {}
    }

    try {
      const chat = normalizeChat(await client.getChat(mid));
      this.rememberChat(chat);
      return chat;
    } catch {}

    if (fallbackUserMid && this.userIndex.has(fallbackUserMid)) {
      return this.chatIndex.get(fallbackUserMid) ?? null;
    }
    return null;
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
    return await Promise.all(messages.map((message) =>
      normalizeMessageFromTalkMessage(TalkMessage, message, client, {
        selfMid: this.selfMid,
        chatMid: mid,
      })
    ));
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
    const chat = await client.getChat(mid);
    const toType = getLineToType(client, mid);
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
    const normalized = normalizeChat(chat);
    return {
      mid,
      name: normalized.name,
      type: normalized.type,
      midType: Number.isFinite(Number(toType)) ? Number(toType) : null,
      midTypeName: midTypeName(toType),
      memberCount: normalized.memberCount,
      memberNames: normalized.memberNames,
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
      cachedChats: this.chatIndex.size,
      cachedFriends: this.userIndex.size,
    };
  }

  async logout() {
    this.client = null;
    this.base = null;
    this.listening = false;
  }
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
