import test from "node:test";
import assert from "node:assert/strict";
import { makeSendReceipt } from "../lib/line-adapter.mjs";

test("makeSendReceipt handles an acknowledgement without contentMetadata", () => {
  const receipt = makeSendReceipt({ id: "123", to: "room", createdTime: 1000 }, {
    selfMid: "self",
    chatMid: "room",
    text: "hello",
    e2ee: true,
  });
  assert.equal(receipt.id, "123");
  assert.equal(receipt.chatMid, "room");
  assert.equal(receipt.fromMid, "self");
  assert.equal(receipt.text, "hello");
  assert.equal(receipt.sent, true);
  assert.equal(receipt.encrypted, true);
});

test("makeSendReceipt accepts a primitive/empty response", () => {
  const receipt = makeSendReceipt(null, { chatMid: "room", text: "hello" });
  assert.equal(receipt.id, null);
  assert.equal(receipt.sent, true);
  assert.equal(receipt.encrypted, true);
  assert.equal(receipt.text, "hello");
});
