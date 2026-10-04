# GUI 1.2.0 – media complete pass

## Implemented

- Profile avatars for the signed-in user, friends, direct chats, and group members.
- Multiple avatar URL fallbacks derived from `pictureStatus` / `picturePath`.
- Lazy loading of visible photo/sticker messages with `IntersectionObserver`.
- Photo full-resolution retrieval on click and local browser download.
- Sticker image retrieval plus local copy for display/save when the CDN permits fetching.
- Inline video playback with native controls after loading the media.
- Inline audio playback with native controls after loading the media.
- File message card with filename/size and save action after loading.
- Media viewer now supports image, sticker, video, audio and save actions.
- Double-click on inline video opens the media viewer.
- `Ctrl/Cmd+S` in the media viewer triggers save.
- Group member rows show avatars and can open a direct USER chat when a member MID is available.
- Corrected LINE `ContentType.STICKER` handling to value `7` and `FILE` to `14`.

## Media loading policy

Images and stickers are lazy-loaded when near the visible viewport. Video, audio, and files require an explicit load/play action so opening a long conversation does not download large media automatically.

## Validation

- `npm test`: 35 passed, 0 failed.
- `npm run check`: passed.
- No live LINE account/media integration test was performed in this build environment.

## API basis

The implementation follows the public LINEJS 3.4.2 API surface, including `TalkMessage.getData()`, `getFileInfo()`, and `getStickerURL()`. LINEJS 3.4.0 also documents the new Moa/Album service for album photo/video access.
