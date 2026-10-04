import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineAdapter } from '../lib/line-adapter.mjs';

test('albumMedia uses obsResourceId oid/sid from normalized photo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'line-native-album-oid-'));
  const adapter = new LineAdapter({ dataDir: root });
  const calls = [];
  adapter.client = {
    base: {
      moa: {
        async downloadPhoto(args) {
          calls.push(args);
          return new Uint8Array([1, 2, 3]);
        },
      },
    },
  };
  const media = await adapter.albumMedia('c1', 'a1', {
    id: 'p1',
    mediaKind: 'video',
    resourceOid: 'real-oid',
    resourceSid: 'v',
    mime: 'video/mp4',
    name: 'clip.mp4',
  });
  assert.equal(calls[0].chatId, 'c1');
  assert.equal(calls[0].albumId, 'a1');
  assert.equal(calls[0].oid, 'real-oid');
  assert.equal(calls[0].prefix, 'album/v');
  assert.equal(media.kind, 'video');
});

test('albumMedia recovers resource id from album photo cache for legacy callers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'line-native-album-cache-'));
  const adapter = new LineAdapter({ dataDir: root });
  const calls = [];
  adapter.client = {
    base: {
      moa: {
        async downloadPhoto(args) {
          calls.push(args);
          return new Uint8Array([9, 8, 7]);
        },
      },
    },
  };
  adapter.albumPhotoCache.set('c1:a1:first:50', {
    photos: [{ id: 'p1', mediaKind: 'image', resourceOid: 'cached-oid', resourceSid: 'a', mime: 'image/jpeg' }],
  });
  await adapter.albumMedia('c1', 'a1', { id: 'p1', mediaKind: 'image' });
  assert.equal(calls[0].oid, 'cached-oid');
  assert.equal(calls[0].prefix, 'album/a');
});

test('albumMedia retries once after album channel-token rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'line-native-album-token-'));
  const adapter = new LineAdapter({ dataDir: root });
  let attempts = 0;
  let clears = 0;
  adapter.client = {
    base: {
      moa: {
        async downloadPhoto() {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error('Unauthorized'), { status: 401 });
          return new Uint8Array([4, 5, 6]);
        },
        async clearAlbumChannelToken() { clears += 1; },
      },
    },
  };
  const media = await adapter.albumMedia('c1', 'a1', { id: 'p1', mediaKind: 'image', resourceOid: 'oid' });
  assert.equal(attempts, 2);
  assert.equal(clears, 1);
  assert.equal(media.size, 3);
});
