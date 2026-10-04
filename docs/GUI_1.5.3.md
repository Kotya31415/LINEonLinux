# GUI 1.5.3

## Album media fix

LINEJS 3.4.2 documents `client.base.moa.downloadPhoto({ chatId, albumId, oid, prefix? })` and states that the photo item `obsResourceId.oid` is the object identifier; videos use `obsResourceId.sid === "v"` and `prefix: "album/v"`, while images use `album/a`. The GUI now forwards and caches these resource identifiers instead of falling back to the normalized media id. It also recovers identifiers from the adapter photo cache for compatibility and retries once after an explicit album channel-token reset when LINE rejects the token.
