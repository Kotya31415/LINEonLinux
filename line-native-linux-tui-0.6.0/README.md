# LINE Native Linux CLI / TUI 0.6.0

Linux terminal client prototype using `@evex/linejs` as the LINE transport layer.

## Modes

- `npm start` — command-line shell
- `npm run tui` — desktop-style terminal UI
- `npm test` — automated tests

## TUI

The 0.6 TUI is designed to feel closer to a desktop messenger while remaining terminal-native:

- left conversation sidebar with avatar initials, preview, time and unread badge
- main conversation header with chat type/member count
- left/right message bubbles
- CJK-aware display width and wrapping
- chat search (`/`)
- pane switching (`Tab`, `←`, `→`)
- message scrolling (`PgUp`, `PgDn`, `Home`, `End`)
- compose with `i` or `Enter`
- refresh with `r`
- help with `?`
- quit with `q` / `Ctrl+C`

The TUI never silently downgrades an E2EE message to plaintext.

## Data

LINEJS FileStorage defaults to `${XDG_DATA_HOME:-~/.local/share}/line-native-linux` via the adapter's data directory. Override with `LINE_NATIVE_DATA_DIR` for isolated testing.
