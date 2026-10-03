import test from 'node:test';
import assert from 'node:assert/strict';
import { LineTui } from '../lib/tui.mjs';

function fakeAdapter() {
  const listeners = new Map();
  return {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    async login() { listeners.get('ready')?.forEach(fn => fn({ profile: { displayName: 'Test User', mid: 'me' } })); },
    async chats() { return [
      { mid: 'u1', name: 'Alice', kind: 'USER', type: 0, lastUpdate: 3 },
      { mid: 'g1', name: '家族グループ', kind: 'GROUP', type: 2, lastUpdate: 2, memberCount: 4 },
      { mid: 'r1', name: '開発 ROOM', kind: 'ROOM', type: 1, lastUpdate: 1 },
    ]; },
    async history(mid) { return [
      { id: '1', chatMid: mid, text: 'こんにちは世界', createdTime: Date.now() - 1000, isMyMessage: false, fromMid: 'u2', fromName: 'Alice' },
      { id: '2', chatMid: mid, text: 'hello', createdTime: Date.now(), isMyMessage: true, fromMid: 'me' },
    ]; },
    async sendText(mid, text) { return { id: `s-${Date.now()}`, chatMid: mid, text, createdTime: Date.now(), isMyMessage: true, fromMid: 'me' }; },
  };
}

test('0.7 TUI supports filters and selection', async () => {
  const tui = new LineTui(fakeAdapter()); tui.running = true; tui.render = () => {};
  await tui.refreshChats();
  tui.unread.set('g1', 2);
  tui.filter = 'unread';
  assert.deepEqual(tui.filteredIndices(), [1]);
  tui.filter = 'all';
  assert.equal(tui.currentChat.name, 'Alice');
});

test('0.7 TUI opens modal states', () => {
  const tui = new LineTui(fakeAdapter()); tui.running = true; tui.render = () => {};
  tui.openModal('help');
  assert.equal(tui.mode, 'modal');
  assert.equal(tui.modal, 'help');
  tui.closeModal();
  assert.equal(tui.mode, 'normal');
});

test('0.7 TUI command palette transitions', async () => {
  const tui = new LineTui(fakeAdapter()); tui.running = true; tui.render = () => {};
  tui.mode = 'palette';
  await tui.handleKeypress('r', { name: 'r' });
  assert.equal(tui.mode, 'normal');
});

test('0.7 TUI render output contains tgt-style structural elements', async () => {
  const tui = new LineTui(fakeAdapter()); tui.running = true;
  tui.chats = await tui.adapter.chats();
  tui.messages.set('u1', await tui.adapter.history('u1'));
  tui.render = LineTui.prototype.render;
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = chunk => { output += String(chunk); return true; };
  try { tui.render(); } finally { process.stdout.write = original; }
  const plain = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  assert.match(plain, /Chats/);
  assert.match(plain, /Alice/);
  assert.match(plain, /Enter/);
  assert.match(plain, /\?/);
});
