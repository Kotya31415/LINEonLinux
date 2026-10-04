# LINE Native GUI 1.5.0

## Login hardening

- Authentication is single-flight. Concurrent login requests share one in-progress attempt.
- Saved-token login is attempted first in `auto` mode. When it fails, the client switches to QR login instead of leaving the GUI permanently disconnected.
- The base/client authentication state is verified before `ready` is emitted.
- The local profile is fetched before login is declared successful.
- Listener startup is wrapped so a receive-loop startup failure does not masquerade as a successful online state.
- QR/manual login has a 5-minute Electron bridge request window.

## Album / Moa

LINEJS 3.4.0 added the Album/Moa service on `client.base.moa` for album listing, paginated photos, and media downloads. This GUI uses runtime feature detection because the exact method surface can vary with the installed LINEJS build.

The adapter normalizes common album/photo response shapes and caches successfully downloaded album media under `album-cache/`.

The GUI provides an album button in the chat header, album list, paginated photo/video grid, media viewer, and refresh/back navigation.

## Verification

The local Node test suite contains authentication single-flight/fallback tests and Moa album list/pagination/cache tests. Live LINE account and live album verification still need to be performed on a real connected session.
