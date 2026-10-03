import test from 'node:test';
import assert from 'node:assert/strict';
import { LineTui } from '../lib/tui.mjs';

function fakeAdapter() {
  const listeners = new Map();
  return {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    async login() { listeners.get('ready')?.forEach(fn => fn({ profile: { displayName: 'Test User', mid: 'me' } })); },
    async chats() { return [
      { mid: 'u1', name: 'Alice', kind: 'USER', type: 0 },
      { mid: 'g1', name: '家族グループ', kind: 'GROUP', type: 2 },
      { mid: 'r1', name: '開発 ROOM', kind: 'ROOM', type: 1 },
    ]; },
    async history(mid) { return [
      { id: '1', chatMid: mid, text: 'こんにちは世界', createdTime: 1, isMyMessage: false, fromMid: 'u2', fromName: 'Alice' },
      { id: '2', chatMid: mid, text: 'hello', createdTime: 2, isMyMessage: true, fromMid: 'me' },
    ]; },
    async sendText(mid, text) { return { id: `s-${Date.now()}`, chatMid: mid, text, createdTime: Date.now(), isMyMessage: true, fromMid: 'me' }; },
  };
}

test('TUI loads, filters, and selects chats', async () => {
  const tui = new LineTui(fakeAdapter());
  tui.running = true;
  tui.render = () => {};
  await tui.refreshChats();
  assert.equal(tui.chats.length, 3);
  tui.searchQuery = '家族';
  assert.equal(tui.filteredIndices().length, 1);
  tui.searchQuery = '';
  tui.selected = 1;
  await tui.openCurrent();
  assert.equal(tui.currentChat.name, '家族グループ');
  assert.equal(tui.messages.get('g1').length, 2);
});

test('TUI input supports multibyte text and sends', async () => {
  const tui = new LineTui(fakeAdapter());
  tui.running = true;
  tui.render = () => {};
  await tui.refreshChats();
  tui.mode = 'compose';
  await tui.handleKeypress('こんにちは', { sequence: 'こんにちは' });
  assert.equal(tui.input, 'こんにちは');
  await tui.send();
  assert.equal(tui.input, '');
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.messages.get('u1').at(-1).text, 'こんにちは');
});

test('incoming messages update previews and unread count', () => {
  const tui = new LineTui(fakeAdapter());
  tui.running = true;
  tui.render = () => {};
  tui.chats = [{ mid: 'u1', name: 'Alice' }, { mid: 'g1', name: 'Group' }];
  tui.selected = 0;
  tui.acceptMessage({ chatMid: 'g1', text: 'new', isMyMessage: false, createdTime: 3 });
  assert.equal(tui.unread.get('g1'), 1);
  assert.equal(tui.messages.get('g1').at(-1).text, 'new');
});

test('same message id is not duplicated', () => {
  const tui = new LineTui(fakeAdapter());
  tui.running = true;
  tui.render = () => {};
  const message = { chatMid: 'u1', id: 'same', text: 'x', createdTime: 4, isMyMessage: false };
  tui.chats = [{ mid: 'u1', name: 'Alice' }];
  tui.acceptMessage(message);
  tui.acceptMessage(message);
  assert.equal(tui.messages.get('u1').length, 1);
});

test('CJK chat names render path does not throw', () => {
  const tui = new LineTui(fakeAdapter());
  tui.running = true;
  tui.render = () => {};
  tui.chats = [{ mid: 'g1', name: 'ミーーーーーーーーーーームdaisuke', kind: 'ROOM', type: 1 }];
  tui.selected = 0;
  assert.doesNotThrow(() => tui.acceptMessage({ chatMid: 'g1', text: '日本語のメッセージ', createdTime: 5, isMyMessage: false }));
});

test('chat sorting promotes the conversation with newest activity', () => {
  const tui = new LineTui(fakeAdapter());
  tui.running = true;
  tui.render = () => {};
  tui.chats = [
    { mid: 'u1', name: 'Older' },
    { mid: 'u2', name: 'Newer' },
  ];
  tui.messages.set('u2', [{ chatMid: 'u2', createdTime: 99, text: 'new', isMyMessage: false }]);
  tui.sortChats('u2');
  assert.equal(tui.chats[0].mid, 'u2');
  assert.equal(tui.currentChat.mid, 'u2');
});

test('search mode narrows the sidebar without changing the stored chats', () => {
  const tui = new LineTui(fakeAdapter());
  tui.running = true;
  tui.render = () => {};
  tui.chats = [
    { mid: 'u1', name: 'Alice' },
    { mid: 'u2', name: 'Bob' },
    { mid: 'g1', name: 'Alice Group' },
  ];
  tui.searchQuery = 'alice';
  assert.deepEqual(tui.filteredIndices(), [0, 2]);
  assert.equal(tui.chats.length, 3);
});
