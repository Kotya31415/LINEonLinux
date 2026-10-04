# LINE Native GUI 1.2.1

## Media transport stability

- Sticker media no longer performs a second CDN fetch inside the Node bridge; the LINEJS sticker URL is returned directly to the renderer.
- Media byte downloads are serialized in the adapter to avoid bursts of concurrent HTTP requests while opening a long chat history.
- Transient `fetch failed` / socket / reset / timeout errors from `TalkMessage.getData()` are retried up to three times with a short backoff.
- The GUI also queues automatic media hydration so a visible history cannot start many IPC media requests at the same time.
- Failed media buttons become explicit retry controls instead of remaining disabled.
- The bridge timeout for media was increased to 60 seconds to accommodate slower large-file downloads.

LINEJS 3.4.2 exposes `TalkMessage.getData(preview?)`, `getFileInfo()`, and `getStickerURL()` for talk media.

## Debugging improvements

Bridge request failures now include the request method, error name, code, and nested cause when available. This makes a remaining transport failure distinguishable from a UI/media rendering failure without exposing message contents.
