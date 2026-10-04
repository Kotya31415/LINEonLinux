# GUI 0.9.0 hardening

The 0.9 GUI remains experimental, but the presentation layer and IPC boundary have been tightened before adding larger LINE features.

## GUI

- chat search with Ctrl/Cmd+K
- ALL / UNREAD / FAVORITE filters
- unread counter maintained from live events
- date separators and sender labels in the timeline
- optimistic outgoing messages with sent/failed state
- best-effort mark-as-read on chat open
- detail pane with chat metadata and known member names
- connection status and bridge error states
- diagnostic modal for transport troubleshooting

## Name resolution

The adapter now keeps a dedicated user-profile cache and resolves senders lazily with `Client.getUser(mid)` when a message does not carry a display name. The normalization path accepts common direct and nested profile shapes, including `targetUserMid` and nested `contact/profile/user/member` holders.

The UI displays a real name when one is available. An unresolved USER MID is shown as `名前未取得` in the main UI; the MID remains available in the information pane for diagnostics.

## IPC

The previous GUI IPC matched replies by message type. That allows two concurrent `chats` or `history` calls to overwrite each other's pending resolver and can produce a timeout even when the underlying request completed.

0.9 uses a per-request `requestId` echoed by the bridge. This makes simultaneous requests independently routable. Login also returns a request-specific `login_ok` response rather than relying on the asynchronous `ready` event as the direct RPC result.


## 0.9.1 name resolution fix

LINEJS 3.4.x exposes the real profile name for `Client.getUser()` / `fetchUsers()` through `User.raw.targetProfileDetail.profileName`. The GUI adapter now recognizes this field and `friendDetail.overriddenName` (the local display-name override), so message sender names no longer depend on a non-existent top-level `displayName` property.

## 1.0.0 GUI completion pass

The 1.0.0 pass focuses on desktop-client usability without adding unsupported LINE endpoints.

- Functional navigation rail for messages, friends, favorites and settings.
- Friend list backed by `Client.fetchUsers()` through a new GUI IPC method.
- Per-device display aliases and favorites stored in local browser storage.
- Chat information is fetched through the adapter's existing `chatInfo()` method.
- Message copy action, optimistic send state, duplicate reconciliation for echoed self messages, and a jump-to-latest control.
- Local density and Enter-to-send settings.
- Explicit connection/disconnect UI and a diagnostics entry point.
- IPC methods added: `friends`, `chat_info`, `logout`.
