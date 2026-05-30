export type RuntimeKind = "codex" | "pi" | "claude-code" | "manual";

export type PlanStatus = "planning" | "implementing" | "done" | "canceled" | "expired";

export type PlanOrigin =
  | { kind: "blank" }
  | { kind: "text-import" }
  | { kind: "file-import"; sourcePath: string };

export interface HarnessRef {
  id: string;
  type: RuntimeKind;
  label: string;
  connectedAt?: string;
  lastActiveAt?: string;
}

export interface PlanFileEntry {
  path: string;
  type: "markdown" | "html";
  title: string;
  purpose: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanManifest {
  id: string;
  name: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  mainFile: "index.md";
  origin: PlanOrigin;
  harnesses: {
    main?: HarnessRef;
    lastActive?: HarnessRef;
  };
  files: PlanFileEntry[];
}

export interface PlanFeedbackItem {
  id: string;
  kind: "chat" | "annotated-feedback" | "render-error";
  status: "open" | "resolved" | "dismissed";
  text: string;
  filePath?: string;
  annotations?: LiteAnnotation[];
  targetHarness?: HarnessRef;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface PlanFeedbackStore {
  items: PlanFeedbackItem[];
}

export interface PlanSummary {
  id: string;
  name: string;
  status: PlanStatus;
  effectiveStatus: PlanStatus;
  updatedAt: string;
  createdAt: string;
  expiresAt: string;
  mainFile: string;
  workspacePath: string;
  files: PlanFileEntry[];
  openFeedbackCount: number;
}

export interface PlanWorkspaceView {
  manifest: PlanManifest;
  effectiveStatus: PlanStatus;
  workspacePath: string;
  feedback: PlanFeedbackStore;
  harnesses?: HarnessPresence[];
  targetHarnessId?: string;
}

export interface CreatePlanRequest {
  name?: string;
  origin: PlanOrigin;
  indexText?: string;
  runtime?: RuntimeKind;
  harness?: HarnessRef;
}

export interface CreatePlanResponse {
  planId: string;
  url: string;
  manifest: PlanManifest;
}

export interface UpsertPlanFileRequest {
  path: string;
  title?: string;
  purpose?: string;
  content: string;
}

export interface UpdatePlanFileMetadataRequest {
  title?: string;
  purpose?: string;
}

export interface UpdatePlanMetadataRequest {
  name?: string;
  status?: PlanStatus;
  mainHarnessId?: string;
}

export interface AddPlanFeedbackRequest {
  kind: "chat" | "annotated-feedback" | "render-error";
  text: string;
  filePath?: string;
  annotations?: LiteAnnotation[];
  targetHarnessId?: string;
}

export interface UpdatePlanFeedbackRequest {
  status?: "open" | "resolved" | "dismissed";
  resolution?: string;
}

export interface ImplementPlanRequest {
  targetHarnessId?: string;
  allowOpenFeedback?: boolean;
  instruction?: string;
}

export type SessionStatus =
  | "active"
  | "agent-processing"
  | "plan-updated"
  | "reply-received"
  | "delivery-failed"
  | "closed";

export type ConversationRole = "user" | "agent" | "system";
export type ConversationKind =
  | "chat"
  | "annotated-feedback"
  | "plan-update"
  | "delivery-status";

export type PlanEventName =
  | "feedback.submitted"
  | "feedback.requested"
  | "feedback.answered"
  | "plan.accepted"
  | "plan.build"
  | "plan.updated";

export interface LiteAnnotation {
  id: string;
  type: "COMMENT" | "DELETION" | "GLOBAL_COMMENT";
  originalText: string;
  comment?: string;
  blockId?: string;
  label?: string;
  prefix?: string;
  suffix?: string;
}

/**
 * A harness instance currently connected to a session's SSE stream. Routing
 * keys on `harnessId` (unique per instance); `harnessType` + `label` let the
 * browser tell multiple connected instances of the same type apart.
 */
export interface HarnessPresence {
  harnessId: string;
  harnessType: RuntimeKind;
  label: string;
  connectedAt: number;
  lastActiveAt?: number;
}

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  kind: ConversationKind;
  text: string;
  annotations?: LiteAnnotation[];
  createdAt: number;
}

export interface PlanModification {
  id: string;
  type: "added" | "removed" | "changed";
  beforeStartLine?: number;
  beforeEndLine?: number;
  afterStartLine?: number;
  afterEndLine?: number;
  beforeText?: string;
  afterText?: string;
}

export interface PlanVersion {
  id: string;
  version: number;
  hash: string;
  text: string;
  source: "initial" | "watcher" | "harness";
  modifications: PlanModification[];
  createdAt: number;
}

export interface FeedbackBatch {
  id: string;
  messageId: string;
  status: "submitted" | "clarifying" | "answered" | "resolved";
  planVersionId: string;
  message: ConversationMessage;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackSuggestion {
  id: string;
  label: string;
  description: string;
}

export interface FeedbackQuestion {
  id: string;
  kind: "text" | "single-select" | "multi-select";
  prompt: string;
  required?: boolean;
  suggestions?: FeedbackSuggestion[];
}

export interface FeedbackQuestionRequest {
  id: string;
  feedbackBatchId?: string;
  planVersionId: string;
  questions: FeedbackQuestion[];
  status: "requested" | "answered";
  createdAt: number;
  answeredAt?: number;
}

export interface FeedbackAnswer {
  questionId: string;
  text?: string;
  selectedSuggestionIds?: string[];
}

export interface PlanSession {
  id: string;
  runtime: RuntimeKind;
  cwd: string;
  planFile: string;
  absolutePlanPath: string;
  currentPlanHash: string;
  currentPlanText: string;
  previousPlanText?: string;
  versions: PlanVersion[];
  feedbackBatches: FeedbackBatch[];
  feedbackRequests: FeedbackQuestionRequest[];
  messages: ConversationMessage[];
  status: SessionStatus;
  /** Connected harness instances (populated for the public session view). */
  harnesses?: HarnessPresence[];
  /** harnessId of the harness the daemon would route feedback to right now. */
  targetHarnessId?: string;
  /** harnessId of the harness that last signalled a plan change. */
  lastActiveHarnessId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionRequest {
  runtime: RuntimeKind;
  cwd: string;
  planFile: string;
  planText?: string;
  transport?: { kind: RuntimeKind | "none"; [key: string]: unknown };
}

export interface CreateSessionResponse {
  sessionId: string;
  url: string;
}

export interface FeedbackRequest {
  kind: "chat" | "annotated-feedback";
  message: string;
  annotations?: LiteAnnotation[];
  /** Optional user-chosen routing override (a connected harnessId). */
  targetHarnessId?: string;
}

export interface AgentMessageRequest {
  message: string;
}

export interface PlanUpdatedRequest {
  /** harnessId of the harness reporting the change — sets last-active. */
  harnessId?: string;
}

export interface FeedbackRequestedRequest {
  feedbackBatchId?: string;
  questions: FeedbackQuestion[];
}

export interface FeedbackAnsweredRequest {
  requestId: string;
  answers: FeedbackAnswer[];
}

export type PlanDecisionRequest = Record<string, never>;

export type ServerEvent =
  | { type: "session.status"; sessionId: string; status: SessionStatus }
  | { type: "plan.changed"; sessionId: string; planText: string; hash: string; version: PlanVersion }
  | { type: "plan.updated"; sessionId: string; planText: string; hash: string; version: PlanVersion }
  | { type: "plan.unchanged"; sessionId: string; hash: string }
  | { type: "agent.message"; sessionId: string; message: ConversationMessage }
  | { type: "feedback.sent"; sessionId: string; message: ConversationMessage; batch: FeedbackBatch; targetHarnessId?: string }
  | { type: "feedback.submitted"; sessionId: string; batch: FeedbackBatch }
  | { type: "feedback.requested"; sessionId: string; request: FeedbackQuestionRequest; targetHarnessId?: string }
  | { type: "feedback.answered"; sessionId: string; request: FeedbackQuestionRequest; answers: FeedbackAnswer[]; targetHarnessId?: string }
  | { type: "plan.accepted"; sessionId: string; message: ConversationMessage; targetHarnessId?: string }
  | { type: "plan.build"; sessionId: string; message: ConversationMessage; targetHarnessId?: string }
  | { type: "harness.presence"; sessionId: string; harnesses: HarnessPresence[]; targetHarnessId?: string }
  | { type: "implementation.requested"; sessionId: string; message: ConversationMessage; targetHarnessId?: string }
  | { type: "file.changed"; sessionId: string; filePath: string }
  | { type: "feedback.added"; sessionId: string; feedback: PlanFeedbackItem }
  | { type: "feedback.updated"; sessionId: string; feedback: PlanFeedbackItem }
  | { type: "feedback.failed"; sessionId: string; error: string; messageId?: string };

export interface MarkdownBlock {
  id: string;
  type: "heading" | "paragraph" | "list-item" | "code" | "hr" | "blockquote";
  content: string;
  level?: number;
  startLine: number;
  language?: string;
  ordered?: boolean;
  checked?: boolean;
}

// ---------------------------------------------------------------------------
// Matcher-list parser
//
// A matcher is a function that inspects the line array starting at index `i`
// and either returns `{ block, consumed }` (number of lines consumed, always
// >= 1) or `null` (not a match). Matchers are tried in order; the first match
// wins. New block kinds are added by appending a matcher — no edits to the
// core loop.
// ---------------------------------------------------------------------------

interface MatchResult {
  block: Omit<MarkdownBlock, "id">;
  consumed: number;
}

type Matcher = (lines: string[], i: number, nextId: () => string) => MatchResult | null;

// Code fence — must run before heading/list so ``` isn't misread.
const matchCodeFence: Matcher = (lines, i) => {
  const raw = lines[i] ?? "";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return null;
  // Capture language from info string (everything after the opening ```)
  const infoString = trimmed.slice(3).trim();
  const startLine = i + 1;
  const code: string[] = [];
  let j = i + 1;
  while (j < lines.length && !lines[j]?.trim().startsWith("```")) {
    code.push(lines[j] ?? "");
    j += 1;
  }
  // j now points to the closing fence (or end of input)
  const consumed = j - i + 1; // +1 to consume the closing fence line
  return {
    block: {
      type: "code",
      content: code.join("\n"),
      startLine,
      ...(infoString.length > 0 ? { language: infoString } : {}),
    },
    consumed,
  };
};

// ATX headings (# … ######)
const matchHeading: Matcher = (lines, i) => {
  const raw = lines[i] ?? "";
  const m = raw.trim().match(/^(#{1,6})\s+(.*)$/);
  if (!m) return null;
  return {
    block: {
      type: "heading",
      content: m[2] ?? "",
      level: m[1]?.length ?? 1,
      startLine: i + 1,
    },
    consumed: 1,
  };
};

// Thematic break (--- or ***)
const matchHr: Matcher = (lines, i) => {
  const trimmed = (lines[i] ?? "").trim();
  if (trimmed !== "---" && trimmed !== "***") return null;
  return { block: { type: "hr", content: "", startLine: i + 1 }, consumed: 1 };
};

// Blockquote — merge consecutive `> ` lines into one block
const matchBlockquote: Matcher = (lines, i) => {
  const raw = lines[i] ?? "";
  if (!raw.trimStart().startsWith("> ") && raw.trim() !== ">") return null;
  const startLine = i + 1;
  const quoteLines: string[] = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j] ?? "";
    if (line.trimStart().startsWith("> ")) {
      quoteLines.push(line.trimStart().slice(2));
      j += 1;
    } else if (line.trim() === ">") {
      quoteLines.push("");
      j += 1;
    } else {
      break;
    }
  }
  if (quoteLines.length === 0) return null;
  return {
    block: { type: "blockquote", content: quoteLines.join("\n"), startLine },
    consumed: j - i,
  };
};

// List items — bullet (- * +) or ordered (1.), with indent nesting + checkbox
const matchListItem: Matcher = (lines, i) => {
  const raw = lines[i] ?? "";
  // Count leading spaces for nesting level (2 spaces per level, 0-indexed)
  const indent = raw.match(/^(\s*)/)?.[1]?.length ?? 0;
  const level = Math.floor(indent / 2);
  const trimmed = raw.trimStart();

  const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
  const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/);

  let content: string;
  let ordered: boolean;

  if (orderedMatch) {
    content = orderedMatch[2] ?? "";
    ordered = true;
  } else if (bulletMatch) {
    content = bulletMatch[1] ?? "";
    ordered = false;
  } else {
    return null;
  }

  // Checkbox detection: `[ ] ` or `[x] ` / `[X] ` at the start of content
  let checked: boolean | undefined;
  if (content.startsWith("[ ] ")) {
    checked = false;
    content = content.slice(4);
  } else if (content.startsWith("[x] ") || content.startsWith("[X] ")) {
    checked = true;
    content = content.slice(4);
  }

  return {
    block: {
      type: "list-item",
      content,
      level,
      ordered,
      ...(checked !== undefined ? { checked } : {}),
      startLine: i + 1,
    },
    consumed: 1,
  };
};

// Ordered list of matchers — append here to add new block kinds.
const MATCHERS: readonly Matcher[] = [
  matchCodeFence,
  matchHeading,
  matchHr,
  matchBlockquote,
  matchListItem,
];

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let idCounter = 0;
  const nextId = () => `block-${idCounter++}`;

  // Paragraph accumulator — flushed when a structural block or blank line appears.
  let paragraphLines: string[] = [];
  let paragraphStart = 1;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push({
      id: nextId(),
      type: "paragraph",
      content: paragraphLines.join("\n"),
      startLine: paragraphStart,
    });
    paragraphLines = [];
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";

    // Blank line — flush any accumulated paragraph and skip.
    if (raw.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    // Try each structural matcher in order.
    let matched = false;
    for (const matcher of MATCHERS) {
      const result = matcher(lines, i, nextId);
      if (result === null) continue;
      flushParagraph();
      blocks.push({ id: nextId(), ...result.block });
      i += result.consumed;
      matched = true;
      break;
    }

    if (!matched) {
      // Accumulate into paragraph.
      if (paragraphLines.length === 0) paragraphStart = i + 1;
      paragraphLines.push(raw);
      i += 1;
    }
  }

  flushParagraph();
  return blocks;
}
