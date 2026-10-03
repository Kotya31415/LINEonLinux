# TUI 0.7 Design

Inspired by the interaction patterns of `tgt`: strong borders, focused panes, modal views, a command palette, and a context-sensitive footer. This is an original layout rather than copied source or artwork.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ LINE Native Linux                                      ● READY   kotya       │
│ ⌕ Search chats                         Ctrl+K commands   / search   ? help  │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ ● Chats  3/3          │ ● Alice  USER · 1 member                           │
│  1 ALL  2 UNREAD 3 FAV│  ─────────────────────────────────────────────────  │
│ ▸ A Alice       12:10 │                       ┌───────────────────────────┐  │
│   家族グループ  11:58 │                       │ hello                     │  │
│   開発 ROOM     10:34 │                       └───────────────────────────┘  │
│                       │  ┌──────────────────────────┐                       │
│                       │  │ こんにちは世界            │                       │
│                       │  └──────────────────────────┘                       │
│                       │                                                      │
│  Enter open  r refresh │  › i / Enter to compose…                           │
│  3 chats              │  Live · receiving messages                          │
│                       │  [↑↓] select [Enter] open [i] compose [/] search…  │
└───────────────────────┴──────────────────────────────────────────────────────┘
```
