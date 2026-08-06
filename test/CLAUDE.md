# test/
> L2 | Parent: ../AGENTS.md

## Members

- `self-test.mjs`: config migration, transport boundaries, lease handoffs, wake-word scoring, VAD
  and ASR maths, manifest/Capabilities, and both WebUI pages.
- `storage-test.mjs`: real directories and a real SQLite file — grouping, archive-before-delete
  ordering, and crash recovery on either side of the commit.
- `blank-test.mjs`: a blank result leaves no trace on disk.
- `lifecycle-test.mjs`, `state-test.mjs`: chain start/stop and the state stream.

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
