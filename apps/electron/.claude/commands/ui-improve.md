---
description: "Run ONE UI/UX improvement cycle on a component. Usage: /ui-improve <target> [focus]. Drives audit → propose → implement → verify → regression via the ui-harness orchestrator. Leaves work uncommitted for human review."
---

Run one UI/UX improvement cycle on the named target.

**Arguments**: `$ARGUMENTS`

Parse `$ARGUMENTS` as `<target> [focus]`:
- `<target>`: a component file path OR component name (e.g. `Editor`, `Timeline`, `apps/electron/src/renderer/src/components/CaptionEditor.tsx`).
- `[focus]` (optional): narrows lenses (e.g. `accessibility`, `motion`, `ai-interaction`). Default: all 6 lenses.

If `<target>` is missing, ask the user once.

Then spawn `ui-harness` with the target + focus. Stream its progress to the user. When it finishes (success OR gate failure), relay the final summary table verbatim — do not re-summarize.

After the harness exits, ask the user one of:
- `commit` — to commit the staged work
- `redo <stage>` — to re-run from a specific stage (1–5)
- `discard` — to revert the uncommitted edits

Do not commit or revert on your own.
