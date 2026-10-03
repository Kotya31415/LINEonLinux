# Account / ToS risk note

This client uses an unofficial LINE protocol implementation rather than the public LINE Messaging API. There is no documented promise that such a client is safe from account restrictions.

LINE's Common Terms of Use prohibit certain forms of reverse engineering, service interference, spam, and improper use, and LINE reserves the right to restrict or terminate service under applicable terms. See the current official terms before using the client on an important account.

Operationally, keep requests low-volume, do not automate bulk messaging/friend adds, do not probe endpoints aggressively, and do not try to bypass server-side limits. The client also keeps E2EE errors explicit rather than silently downgrading to plaintext.
