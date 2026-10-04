# LINE Native GUI 1.5.4

Album/Moa download fix over LINEJS 3.4.2.

# LINE Native GUI 1.5.2

Experimental desktop LINE client built around `@evex/linejs` 3.4.2.

## 1.5.2 fixes

- Stabilizes avatar DOM nodes. Async login/chat-info updates no longer replace root avatar elements, removing the `Cannot read properties of null (reading 'replaceWith')` failure mode seen during login and chat switching.
- Infers GROUP/ROOM type from `BaseClient.getToType()` when the joined-chat payload omits a usable type field.
- Keeps chat selection and profile/avatar updates independent from asynchronous info requests.

## Development

```bash
npm install
npm test
npm run check
npm start
```

## 1.5.4

Album photo thumbnails are now progressively eager-loaded with a small worker pool, so photo tiles no longer require an individual click before displaying. Video items without a thumbnail remain click-to-load to avoid unexpectedly downloading large video files.
