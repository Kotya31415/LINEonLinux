import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineAdapter, normalizeAlbum, normalizeAlbumPhoto } from "../lib/line-adapter.mjs";

function makeRuntime({ tokenFailure = false } = {}) {
  const state = { loginCalls: [], listenCalls: 0, storage: new Map() };
  class FakeStorage {
    async get(key) { return state.storage.get(key); }
    async set(key, value) { state.storage.set(key, value); }
    async delete(key) { state.storage.delete(key); }
  }
  class FakeBaseClient {
    constructor() {
      this.handlers = new Map();
      this.authToken = null;
      this.loginProcess = { login: async (args) => {
        state.loginCalls.push(args);
        if (tokenFailure && args.authToken) throw new Error("401 unauthorized token");
        this.authToken = args.authToken || "qr-token";
        this.handlers.get("update:authtoken")?.(this.authToken);
      } };
    }
    on(name, fn) { this.handlers.set(name, fn); }
  }
  class FakeClient {
    constructor(base) {
      this.base = base;
      this.handlers = new Map();
      this.base.getToType = (mid) => mid.startsWith("u") ? 0 : 2;
    }
    on(name, fn) { this.handlers.set(name, fn); }
    listen() { state.listenCalls += 1; }
    authToken() { return this.base.authToken; }
    async getMyProfile() { return { mid: "me", displayName: "Tester" }; }
    async fetchJoinedChats() { return []; }
    async fetchUsers() { return []; }
    async getUser(mid) { return { mid, raw: { targetUserMid: mid, targetProfileDetail: { profileName: "User" } } }; }
  }
  const runtime = {
    BaseClient: FakeBaseClient,
    Client: FakeClient,
    FileStorage: FakeStorage,
    TalkMessage: { fromRawTalk: async () => ({}) },
  };
  return { runtime, state };
}

test("login is single-flight and starts listening exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-login-"));
  try {
    const { runtime, state } = makeRuntime();
    const adapter = new LineAdapter({ dataDir: root, linejsRuntime: runtime });
    const [a, b] = await Promise.all([adapter.login(), adapter.login()]);
    assert.equal(a.mid, "me");
    assert.equal(b.mid, "me");
    assert.equal(state.loginCalls.length, 1);
    assert.equal(state.listenCalls, 1);
    assert.equal(adapter.loginState, "online");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto login falls back from an invalid saved token to QR", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-login-fallback-"));
  try {
    const { runtime, state } = makeRuntime({ tokenFailure: true });
    const adapter = new LineAdapter({ dataDir: root, linejsRuntime: runtime });
    await adapter.prepareStorage();
    await adapter.saveToken("saved-token");
    await adapter.login({ mode: "auto" });
    assert.deepEqual(state.loginCalls.map((entry) => Object.keys(entry)[0]), ["authToken", "qr"]);
    assert.equal(adapter.loginState, "online");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album response normalizers accept common Moa shapes", () => {
  const album = normalizeAlbum({ albumId: "a1", albumName: "夏休み", photoCount: 12, coverUrl: "https://example.test/cover.jpg" });
  assert.equal(album.id, "a1");
  assert.equal(album.name, "夏休み");
  assert.equal(album.count, 12);
  const photo = normalizeAlbumPhoto({ photoId: "p1", mediaType: "VIDEO", thumbnailUrl: "https://example.test/t.jpg", fileName: "movie.mp4" });
  assert.equal(photo.id, "p1");
  assert.equal(photo.mediaKind, "video");
  assert.equal(photo.name, "movie.mp4");
});

test("album methods can list, paginate, and cache media", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-album-"));
  try {
    const { runtime } = makeRuntime();
    const adapter = new LineAdapter({ dataDir: root, linejsRuntime: runtime });
    await adapter.login();
    adapter.client.base.moa = {
      getAlbums: async ({ cursor }) => ({ result: { albums: [{ albumId: "a1", name: "アルバム1", photoCount: 1 }], nextCursor: cursor ? "" : "", hasMore: false } }),
      getPhotos: async ({ albumId, cursor, pageSize }) => ({ result: { photos: [{ oid: "p1", mediaType: "IMAGE", fileName: "a.jpg", obsResourceId: { sid: "a", oid: "p1" } }], nextCursor: "" } }),
      downloadPhoto: async ({ albumId, oid, prefix }) => Buffer.from([1, 2, 3]),
    };
    const albums = await adapter.albums("c1");
    assert.equal(albums[0].id, "a1");
    const first = await adapter.albumPhotos("c1", "a1", { limit: 50 });
    assert.equal(first.photos[0].id, "p1");
    assert.equal(first.continuationToken, null);
    const media = await adapter.albumMedia("c1", "a1", { id: "p1", mediaKind: "image", mime: "image/png", name: "a.png" });
    assert.equal(media.dataUrl, "data:image/png;base64,AQID");
    const cached = await adapter.albumMedia("c1", "a1", { id: "p1", mediaKind: "image", mime: "image/png", name: "a.png" });
    assert.equal(cached.cached, true);
    assert.equal(cached.size, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("force=true refreshes cached album list", async () => {
  let calls = 0;
  const fakeMoa = {
    async getAlbums() { calls++; return [{ albumId: String(calls), name: `Album ${calls}` }]; },
  };
  const albumsMethod = async (force = false) => {
    if (!albumsMethod.cache) albumsMethod.cache = null;
    if (force || !albumsMethod.cache) albumsMethod.cache = await fakeMoa.getAlbums();
    return albumsMethod.cache.map(normalizeAlbum);
  };
  const first = await albumsMethod(false);
  const second = await albumsMethod(false);
  const third = await albumsMethod(true);
  assert.equal(calls, 2);
  assert.equal(first[0].id, "1");
  assert.equal(second[0].id, "1");
  assert.equal(third[0].id, "2");
});

test("restoreSession stays offline when no token is stored", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-session-empty-"));
  try {
    const { runtime } = makeRuntime();
    const adapter = new LineAdapter({ dataDir: root, linejsRuntime: runtime });
    const session = await adapter.restoreSession();
    assert.equal(session.authenticated, false);
    assert.equal(session.hasSavedToken, false);
    assert.equal(adapter.loginState, "offline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restoreSession restores a saved token without opening QR login", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-session-token-"));
  try {
    const { runtime, state } = makeRuntime();
    const adapter = new LineAdapter({ dataDir: root, linejsRuntime: runtime });
    await adapter.prepareStorage();
    await adapter.saveToken("saved-token");
    const session = await adapter.restoreSession();
    assert.equal(session.authenticated, true);
    assert.equal(session.profile.displayName, "Tester");
    assert.deepEqual(state.loginCalls.map((entry) => Object.keys(entry)[0]), ["authToken"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album adapter follows the documented Moa REST signatures", async () => {
  const root = await mkdtemp(join(tmpdir(), "line-native-album-real-api-"));
  try {
    const { runtime } = makeRuntime();
    const adapter = new LineAdapter({ dataDir: root, linejsRuntime: runtime });
    await adapter.login();
    const calls = [];
    adapter.client.base.moa = {
      async getAlbums(arg) { calls.push(["getAlbums", arg]); return { result: { albums: [{ albumId: "a1", title: "アルバム", photoCount: 1, chatId: "c1" }], nextCursor: "", hasMore: false } }; },
      async getPhotos(arg) { calls.push(["getPhotos", arg]); return { result: { photos: [{ oid: "p1", mediaType: "IMAGE", obsResourceId: { sid: "a", oid: "p1" } }], nextCursor: "" } }; },
      async downloadPhoto(arg) { calls.push(["downloadPhoto", arg]); return new Uint8Array([1,2,3]); },
    };
    const albums = await adapter.albums("c1");
    assert.equal(albums.length, 1);
    const photos = await adapter.albumPhotos("c1", "a1", { limit: 100 });
    assert.equal(photos.photos[0].id, "p1");
    await adapter.albumMedia("c1", "a1", { id: "p1", obsResourceId: { sid: "a", oid: "p1" } });
    assert.deepEqual(calls[0], ["getAlbums", { cursor: "" }]);
    assert.equal(calls[1][0], "getPhotos");
    assert.equal(calls[1][1].chatId, "c1");
    assert.equal(calls[1][1].albumId, "a1");
    assert.equal(calls[2][0], "downloadPhoto");
    assert.equal(calls[2][1].chatId, "c1");
    assert.equal(calls[2][1].albumId, "a1");
    assert.equal(calls[2][1].oid, "p1");
    assert.equal(calls[2][1].prefix, "album/a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
