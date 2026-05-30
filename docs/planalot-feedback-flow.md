# Planalot Feedback and Versioning Flow

## Core contract

Planalot opens and watches an existing `.md` or `.mdx` plan file. It does not create plan files.

Harnesses are responsible for creating or updating the plan file first, then opening it in Planalot.

## Page model

The Planalot browser page is request/response, not a live chat surface.

- The harness/LLM conversation stays in the harness TUI.
- Planalot does not render agent conversation history.
- Planalot does not render assistant replies as chat messages.
- The browser page focuses on the current plan, feedback submission, follow-up question packages, Accept, and Build.

## Events

Canonical event names:

- `feedback.submitted` — browser user submitted a feedback batch.
- `feedback.requested` — harness/agent requested follow-up questions from the browser user.
- `feedback.answered` — browser user answered a requested question package.
- `plan.accepted` — user accepts the plan but does not request implementation.
- `plan.build` — user accepts the plan and requests implementation.
- `plan.updated` — harness reports that it updated the plan file.

## Feedback question packages

Selectable suggestions must always include a `description`.

Descriptions should be detailed enough for the user to understand the choice in context:

- If the user appears misaligned or the option is nuanced, use a longer corrective description.
- If the user is aligned and the option is straightforward, keep it short.

```ts
interface FeedbackSuggestion {
  id: string;
  label: string;
  description: string;
}

interface FeedbackQuestion {
  id: string;
  kind: "text" | "single-select" | "multi-select";
  prompt: string;
  required?: boolean;
  suggestions?: FeedbackSuggestion[];
}
```

## Versioning

Every session starts with version `0` for the initial plan content.

New versions are created when the watched plan file's content hash changes.

Sources:

- `watcher` — Chokidar file watch event after debounce.
- `harness` — harness explicitly reports `plan.updated`, causing an immediate read/diff/version pass.

Each version stores:

- monotonically increasing version number
- content hash
- full plan text
- source (`initial`, `watcher`, `harness`)
- latest trail modifications

## Config

Configuration is read from environment variables and local `.env` / `.env.local` files.

```env
PLANALOT_WATCH_DEBOUNCE_MS=10000
PLANALOT_HARNESS_EVENT_DEBOUNCE_MS=0
PLANALOT_MAX_TRAIL_MODIFICATIONS=3
```

`PLANALOT_MAX_TRAIL_MODIFICATIONS` controls how many recent modification groups are kept for display mechanics.

## Accept vs Build

- `plan.accepted`: tell the harness the plan looks good and it should wait for the user to explicitly ask for implementation.
- `plan.build`: tell the harness the plan was accepted and it should move to implementation.
