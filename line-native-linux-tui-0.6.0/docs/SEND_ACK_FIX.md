# Send acknowledgement handling

Observed behavior on a real ROOM: the LINE service accepted the E2EE message, and the message returned through the live event stream, but the CLI reported `Cannot read properties of undefined (reading 'e2eeVersion')` immediately after send.

Root cause: `Chat.sendMessage()` calls `TalkMessage.fromRawTalk()` on the `/S4` response. In linejs 3.4.2, `TalkMessage.fromRawTalk()` accesses `raw.contentMetadata.e2eeVersion` without guarding `contentMetadata`. Some accepted send responses omit that field.

Fix: use the base TalkService for sending, then return a local acknowledgement object. Never attempt plaintext fallback. The incoming `message` event is still used for the canonical message object.
