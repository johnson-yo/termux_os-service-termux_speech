# service/kws/
> L2 | Parent: ../CLAUDE.md

## Members

- `pinyin-ws.mjs`: the App's private pinyin stream.
- `pinyin-scorer.mjs`, `profile-store.mjs`: matching, and enrolled keyword profiles.
- `gate-lease.mjs`, `controller.mjs`: countdown state and the handoff to VAD.

A hit authorises the handoff and is also a second key to the gate; it never reads the Pool.

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
