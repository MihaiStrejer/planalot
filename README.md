# planalot

A local plan workspace daemon and browser UI for agent planning workflows.

## Stack

- Node.js 22+ native HTTP daemon
- TypeScript ESM packages
- Vite + React single-file browser app
- SSE for live session updates
- pnpm workspaces

## Quick start

```bash
pnpm install
pnpm build
printf '# Plan\n' > PLAN.md
pnpm planalot PLAN.md
```

The CLI starts or reuses a per-user daemon, creates a Planalot-owned workspace under `~/.planalot/plans/<id>`, and opens the browser UI. Imported files are copied into Planalot; Planalot owns the source of truth after creation/import.

## Plan workspaces

Each plan is stored as:

```txt
~/.planalot/plans/<id>/
  manifest.json
  feedback.json
  index.md
  architecture.md
  flow.html
```

`index.md` is required and canonical. Additional top-level sibling `.md` and `.html` files can be added as the plan grows.

Useful CLI commands:

```bash
pnpm planalot create --name "Payments Plan" --json
pnpm planalot import PLAN.md --name "Payments Plan" --json
pnpm planalot find payments --status planning --json
pnpm planalot read <planId> --all --json
pnpm planalot open <planId>
pnpm planalot wait-feedback <planId> --timeout 600 --json
pnpm planalot implement <planId> --json
```

## Pi install

```bash
pnpm planalot install pi
```

Then restart Pi or run `/reload`. The Pi extension provides `/planalot <existing-plan.md>` and the `planalot_open_plan` tool.

## Claude Code install

```bash
pnpm planalot install cc
```

This installs `~/.claude/commands/planalot.md`. In Claude Code, use `/planalot EXISTING_PLAN.md` to open an existing plan, or `/planalot lets start a new plan` to instruct Claude to create a markdown plan first and then open it in Planalot.

## Codex install

```bash
pnpm planalot install codex
codex plugin add planalot@personal
```

Then start a new Codex thread and use `$planalot`. The Codex plugin opens Planalot from the current workspace, but feedback from the browser is manual/copyable until Codex exposes a live extension message bridge like Pi's `sendUserMessage`.

## License

Apache-2.0. See [LICENSE](LICENSE).
