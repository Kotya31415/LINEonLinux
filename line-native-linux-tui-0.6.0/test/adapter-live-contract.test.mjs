import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { LineAdapter } from "../lib/line-adapter.mjs";

function makeMockRuntime() {
  const state = { loginArgs: null, listenCalls: 0, sent: [], plainSent: [], e2eeCalls: [], stored: new Map([["userAuthToken", "saved-token"]]) };
  class FakeStorage {
    async get(key) { return state.stored.get(key); }
    async set(key, value) { state.stored.set(key, value); }
  }
  class FakeBaseClient {
    constructor(init) {
      this.init = init;
      this.handlers = new Map();
      this.loginProcess = { login: async (args) => { state.loginArgs = args; this.handlers.get("update:authtoken")?.("rotated-token"); } };
    }
    on(name, fn) { this.handlers.set(name, fn); }
  }
  class FakeClient {
    constructor(base) {
      this.base = base;
      this.handlers = new Map();
      const baseRef = base;
      this.base.getToType = (mid) => mid.startsWith("u") ? 0 : 2;
      this.base.talk = {
        sendMessage: async (opts) => { state.sent.push({ mid: opts.to, text: opts.text, e2ee: opts.e2ee }); return { id: "m-user", to: opts.to, from: "me", text: opts.text }; },
        getRecentMessagesV2: async ({ messageBoxId, messagesCount }) => {
          state.recentArgs = { messageBoxId, messagesCount };
          return [{ id: "m1", createdTime: 2, to: "me", from: messageBoxId, contentType: "NONE", contentMetadata: {}, text: "hello" }];
        },
        getE2EEPublicKeys: async () => [{ keyId: 1 }],
        getLastE2EEPublicKeys: async () => ({ me: { keyId: 1, keyData: new Uint8Array(32) } }),
        getLastE2EEGroupSharedKey: async () => ({ groupKeyId: 2, creator: "me", creatorKeyId: 1, receiverKeyId: 1, encryptedSharedKey: new Uint8Array(16) }),
        sendCompactMessage: async ({ to, text, e2ee }) => { state.plainSent.push({ to, text, e2ee }); return { messageId: 3n, createdTime: 4 }; },
      };
      this.base.e2ee = {
        getE2EESelfKeyData: async () => ({ keyId: 1, privKey: Buffer.alloc(32, 1).toString("base64"), pubKey: Buffer.alloc(32, 2).toString("base64") }),
        getE2EESelfKeyDataByKeyId: async () => ({ keyId: 1, privKey: Buffer.alloc(32, 1).toString("base64"), pubKey: Buffer.alloc(32, 2).toString("base64") }),
        verifyE2EEKeyPair: () => true,
        generateSharedSecret: () => Buffer.alloc(32, 3),
        getSHA256Sum: () => Buffer.alloc(32, 4),
        xor: () => Buffer.alloc(16, 5),
        encryptE2EETextMessage: (...args) => { state.directEncryptArgs = args; return [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(12, 3), Buffer.alloc(4, 4), Buffer.alloc(4, 5)]; },
        getE2EELocalPublicKey: async (mid, keyId) => {
          state.e2eeCalls.push({ mid, keyId });
          return { keyId: Number(keyId ?? 7), privKey: "group-private" };
        },
      };
    }
    getToType(mid) { return mid.startsWith("u") ? 0 : 2; }
    on(name, fn) { this.handlers.set(name, fn); }
    listen() { state.listenCalls += 1; }
    async getMyProfile() { return { mid: "me", displayName: "Tester", regionCode: "JP" }; }
    async fetchJoinedChats() { return [{ mid: "c1", name: "Group A", raw: { chatMid: "c1", chatName: "Group A", type: 2 } }]; }
    async fetchUsers() { return [{ mid: "u1", raw: { targetUserMid: "u1", displayName: "Alice" } }]; }
    async getUser(mid) { return { mid, raw: { targetUserMid: mid, displayName: "Alice" } }; }
    async getChat(mid) {
      return {
        mid,
        name: mid === "u1" ? "Alice" : "Group A",
        raw: { chatMid: mid, chatName: mid === "u1" ? "Alice" : "Group A", type: mid === "u1" ? 0 : 2, members: [] },
      };
    }
  }
  const FakeTalkMessage = { fromRawTalk: async (raw) => ({ raw, text: () => raw.text ?? "", from: () => raw.from, to: () => raw.to, isMyMessage: () => raw.from === "me" }) };
  return { runtime: { BaseClient: FakeBaseClient, Client: FakeClient, FileStorage: FakeStorage, TalkMessage: FakeTalkMessage }, state };
}

test("adapter discovers personal chats from friends", async () => {
  const { runtime } = makeMockRuntime();
  const adapter = new LineAdapter({ dataDir: "/tmp/line-native-linux-contract", linejsRuntime: runtime });
  await adapter.login();
  const chats = await adapter.chats();
  assert.deepEqual(chats.map((c) => c.mid), ["c1", "u1"]);
  assert.equal(chats[1].name, "Alice");
  assert.equal(chats[1].type, 0);
});

test("adapter resolves and sends to personal USER MID", async () => {
  const { runtime, state } = makeMockRuntime();
  const adapter = new LineAdapter({ dataDir: "/tmp/line-native-linux-contract", linejsRuntime: runtime });
  await adapter.login();
  await adapter.sendText("u1", "hello", { e2ee: true });
  assert.deepEqual(state.sent, [{ mid: "u1", text: "hello", e2ee: true }]);
});

test("explicit plaintext send uses compact public API", async () => {
  const { runtime, state } = makeMockRuntime();
  const adapter = new LineAdapter({ dataDir: "/tmp/line-native-linux-contract", linejsRuntime: runtime });
  await adapter.login();
  const sent = await adapter.sendPlainText("c1", "plain");
  assert.equal(sent.encrypted, false);
  assert.deepEqual(state.plainSent, [{ to: "c1", text: "plain", e2ee: false }]);
});

test("group E2EE send uses direct current group-key transport", async () => {
  const { runtime, state } = makeMockRuntime();
  const adapter = new LineAdapter({ dataDir: "/tmp/line-native-linux-contract", linejsRuntime: runtime });
  await adapter.login();
  adapter.getCurrentGroupKeyMaterial = async (mid) => ({
    mid, groupKeyId: 7, creator: "me", creatorKeyId: 1, receiverKeyId: 1, selfKeyId: 1,
    groupPrivateKey: Buffer.alloc(32, 9),
  });
  adapter.client.base.e2ee.generateSharedSecret = () => Buffer.alloc(32, 3);
  adapter.client.base.e2ee.encryptE2EETextMessage = (...args) => { state.directEncryptArgs = args; return [Buffer.from("salt"), Buffer.from("enc"), Buffer.from("sign"), Buffer.alloc(4), Buffer.alloc(4)]; };
  adapter.client.base.talk.sendMessage = async (opts) => { state.directSend = opts; return { id: "m-direct", to: opts.to, from: "me", text: "hello", contentType: "NONE", contentMetadata: opts.contentMetadata, chunks: opts.chunks }; };
  const sent = await adapter.sendText("c1", "hello", { e2ee: true });
  assert.equal(sent.chatMid, "c1");
  assert.equal(state.directSend.e2ee, true);
  assert.equal(state.directSend.chunks.length, 5);
  assert.equal(state.directEncryptArgs[1], 7);
});

test("adapter resolves MID type from BaseClient, not the public Client wrapper", async () => {
  const { runtime } = makeMockRuntime();
  const adapter = new LineAdapter({ dataDir: "/tmp/line-native-linux-contract", linejsRuntime: runtime });
  await adapter.login();
  assert.equal((await adapter.chatInfo("c1")).midTypeName, "GROUP");
});


test("adapter direct current-group-key transport bypasses linejs recreation path", async () => {
  const { runtime, state } = makeMockRuntime();
  const adapter = new LineAdapter({ dataDir: "/tmp/line-native-linux-contract", linejsRuntime: runtime });
  await adapter.login();
  adapter.getCurrentGroupKeyMaterial = async (mid) => ({
    mid, groupKeyId: 7, creator: "u1", creatorKeyId: 1, receiverKeyId: 1, selfKeyId: 1,
    groupPrivateKey: Buffer.alloc(32, 9),
  });
  adapter.client.base.e2ee.getE2EESelfKeyData = async () => ({ keyId: 1, privKey: Buffer.alloc(32, 1).toString("base64"), pubKey: Buffer.alloc(32, 2).toString("base64") });
  adapter.client.base.e2ee.generateSharedSecret = () => Buffer.alloc(32, 3);
  adapter.client.base.e2ee.encryptE2EETextMessage = (...args) => { state.directEncryptArgs = args; return [Buffer.from("salt"), Buffer.from("enc"), Buffer.from("sign"), Buffer.alloc(4), Buffer.alloc(4)]; };
  adapter.client.base.talk.sendMessage = async (opts) => { state.directSend = opts; return { id: "m-direct", to: opts.to, from: "me", text: "hello", contentType: "NONE", contentMetadata: opts.contentMetadata, chunks: opts.chunks }; };
  const message = await adapter.sendTextDirectCurrentGroupKey("c1", "hello");
  assert.equal(message.chatMid, "c1");
  assert.equal(state.directSend.to, "c1");
  assert.equal(state.directSend.e2ee, true);
  assert.equal(state.directSend.chunks.length, 5);
  assert.equal(state.directEncryptArgs[1], 7);
});

test.after(async () => { await rm("/tmp/line-native-linux-contract", { recursive: true, force: true }); });
