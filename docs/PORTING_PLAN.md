# Porting plan: macOS OSS -> Linux-native LINE client

## Candidates investigated

### 1. Relay — primary UI architecture reference
- Native macOS application written in SwiftUI.
- Uses a separate pure-Swift Matrix SDK (`MatrixKit`).
- Feature set maps closely to a modern desktop messenger: room list, unread counts, rich timeline, attachments, reactions, replies, typing indicators, deep links, notifications/session handling.
- Code license: Apache-2.0.

Why it is useful: it demonstrates a strong separation between a native desktop presentation layer and a protocol/service layer. We should port the *architecture and interaction model*, not Apple SwiftUI itself.

### 2. Mactrix — native macOS + Rust backend reference
- Native macOS SwiftUI frontend.
- Uses `matrix-rust-sdk` beneath it.
- GPL-3.0.

Why it is useful: it is an example of a modern SwiftUI frontend delegating protocol/state-heavy work to a Rust library, which is conceptually close to a Rust/GTK Linux frontend plus a protocol service.

### 3. Signal Desktop — large production messenger reference
- Open-source desktop messenger for Windows/macOS/Linux.
- Electron/TypeScript based.
- AGPL-3.0.

Why it is useful: excellent reference for production-grade desktop messaging state, storage, attachments, events, notifications and database structure. Less useful as a *native UI* source because the UI is web technology.

### 4. Telegram Desktop — best cross-platform native-code reference
- Official desktop client source is public.
- GPLv3 with OpenSSL exception.
- Uses Qt 6 and explicitly supports macOS and Linux.

Why it is useful: it proves a large desktop messenger can share a native C++/Qt codebase across macOS and Linux. It is more directly portable than a SwiftUI-only project.

### 5. Line-GTK — functional LINE reference
- Unofficial Linux LINE client using GTK4/Libadwaita.
- Rust frontend with a Deno `linejs` protocol sidecar.
- GPL-3.0-or-later.
- Current feature list includes QR login, chats/messages/stickers/friends, media/files, viewers, tray, themes and account switching.

Why it is useful: this is the closest existing implementation to the actual target. Rather than reproducing LINE protocol logic, it is sensible to treat it as a live reference and build a cleaner, modular native frontend around the same protocol boundary.

## Recommended architecture

```text
+---------------------------+
| GTK4 / Rust               |
|                           |
| ChatList                  |
| Timeline                  |
| Composer                  |
| AttachmentViewer          |
| Search                    |
| Notifications / tray      |
+-------------+-------------+
              |
              | typed JSON/IPC
              v
+---------------------------+
| LINE service adapter      |
|                           |
| login                     |
| contacts/chats            |
| message history           |
| live events               |
| media                     |
| reactions/replies         |
+-------------+-------------+
              |
              | JS API
              v
+---------------------------+
| @evex/linejs              |
|                           |
| Thrift / LEGY / E2EE      |
+---------------------------+
```

## Why not directly port SwiftUI?

SwiftUI is Apple-platform UI technology. The reusable part is the application's state model, event model, data flow and feature decomposition—not the widget implementation itself.

For Linux, GTK4/Libadwaita gives better Wayland/KDE/GNOME integration. Qt6 is a second viable option; Telegram Desktop demonstrates that route.

## Implementation phases

### Phase 0 — done in this prototype
- Native-ish Linux window shell.
- Three-column messenger concepts reduced to a clean two-pane layout.
- Search, selection, timeline and composer.
- Backend seam and JSON event vocabulary.
- No proprietary LINE assets.

### Phase 1 — first real account integration
1. Spawn the Node sidecar from Rust.
2. Send `login_qr`.
3. Render returned QR URL as a QR image.
4. Handle `pin` and `ready` events.
5. Persist session in the sidecar storage.

### Phase 2 — read-only real LINE data
1. Fetch chat MIDs.
2. Fetch chat metadata/contacts.
3. Fetch recent message history.
4. Map LINE message objects into the UI's stable internal `Chat`/`Message` structs.
5. Add incremental live-event handling.

### Phase 3 — messaging
1. Send text.
2. Handle E2EE failures explicitly.
3. Show delivery/error state.
4. Mark read / unread.
5. Reconnect and resume event streams.

### Phase 4 — media and rich features
1. Download media to cache.
2. Image/video/file attachments.
3. Stickers and emoji.
4. Replies/reactions.
5. Drag-and-drop and clipboard.

### Phase 5 — desktop integration
1. libnotify notifications.
2. KDE/Wayland tray integration.
3. `.desktop` launcher.
4. Config and session backup.
5. Optional Flatpak packaging.

## Important compatibility boundary

Keep LINE protocol details out of the GTK code. This makes it possible to replace `linejs` later with another backend if the protocol or authentication stack changes.
