# web/
> L2 | Parent: ../AGENTS.md

## Members

- `index.html`, `app.js`, `views.js`, `style.css`: the 概览 / 设置 / 诊断 pages, laid out for
  390 dp. `app.js` does the I/O, `views.js` renders and performs none.
- `setup.html`, `setup.js`, `setup.css`: wake-word enrollment, build and test.

## Rules

- An unrecognised response shape is an explicit error, never an empty list.
- Highlighting has two independent dimensions: `active` is "working now", `owner` is "may close".
  Nothing keys off historical fields.
- A group being edited is never overwritten by a background refresh.
- Both pages use the Browser Session and never ask for a credential.

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
