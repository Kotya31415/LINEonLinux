# LINE transport implementation

## What is real here

The CLI uses the public API of `@evex/linejs` 3.4.2. LINEJS documents support for QR login, auth-token login, `FileStorage`, the `Client` event listener, `fetchJoinedChats()`, `getChat().fetchMessages()`, and `Chat.sendMessage()`.

The adapter deliberately uses the lower-level `BaseClient` login flow so token/QR/PIN listeners are attached **before** login. This matters because LINEJS documents that login can issue/rotate an auth token during the login operation.

The selected default emulation profile is `DESKTOPMAC`, exposed by LINEJS as a supported device value. Set `LINE_DEVICE=DESKTOPWIN` to use the Windows desktop profile for comparison.

## Session persistence

`FileStorage` is kept under:

```text
~/.local/share/line-native-linux/storage.json
```

The containing directory is created with mode 0700 and the storage file is chmodded to 0600 where the host OS permits it.

The auth token is also stored under the `userAuthToken` key because LINEJS documents that `FileStorage` persists cert/refresh/E2EE material but does not persist the auth token itself.

## E2EE

Text sends use the high-level `Chat.sendMessage()` with `{ e2ee: true }`. LINEJS documents that this API handles E2EE encryption and that `Client.listen()` handles E2EE decryption for supported messages when key material is available.

## Event loop

After successful login the adapter calls `client.listen()` exactly once. `message` and `message:edit` events are normalized and surfaced to the CLI. The adapter keeps event handlers small and catches listener failures so a UI callback cannot crash the transport process.

## Testing boundary

Automated tests in this repository cover the JSON normalization layer, adapter configuration, and script syntax. A real account integration test was **not** run from this environment because it would require a user-controlled LINE login/QR session. The first live test should be done manually with `login qr`, followed by `profile`, `chats`, `use <MID>`, `history`, and a controlled message to a test chat.


## 0.4.1 live-behavior notes

LINEJS 3.4.2 implements `fetchJoinedChats()` using `getAllChatMids({ withMemberChats: true })` followed by `getChats()`. This can leave a user's personal conversations out of the returned chat list on some accounts, so the CLI now supplements it with `Client.fetchUsers()` and treats each friend as a direct USER-MID target. LINEJS exposes `getUser(mid)` and its `User` model publicly.

The E2EE send path intentionally remains strict. LINEJS's current E2EE group path retrieves the last group key and, when none is available, attempts `tryRegisterE2EEGroupKey()`. A server response of `E2EE_RECREATE_GROUP_KEY` is surfaced instead of being hidden.

## 0.4.1 B-path E2EE preflight

The adapter now serializes E2EE sends and, for ROOM/GROUP targets, performs a current-key preflight before calling `Chat.sendMessage({ e2ee: true })`. It obtains the server's current `getLastE2EEGroupSharedKey`, resolves exactly that generation through `getE2EELocalPublicKey(mid, groupKeyId)`, then temporarily supplies the resolved generation to linejs's no-key-id resolver during the nested send. This is deliberately a narrow compatibility shim: it does not modify the E2EE cryptography or register a new group key, and it still refuses automatic plaintext downgrade.

The CLI adds `e2ee-preflight`, which exposes the same key-id consistency check without sending a message.
