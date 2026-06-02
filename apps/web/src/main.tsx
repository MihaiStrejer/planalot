import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Check,
  Copy,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Sun,
} from "lucide-react";
import {
  parseMarkdownBlocks,
  type FeedbackAnswer,
  type FeedbackQuestionRequest,
  type HarnessPresence,
  type LiteAnnotation,
  type PlanFileEntry,
  type PlanSession,
  type PlanSummary,
  type ServerEvent,
} from "@planalot/shared";
import "./styles.css";

// Render pipeline — populates blockRegistry / codeRegistry on import.
import "./render/index";
import { BlockRenderer } from "./render/BlockRenderer";
import { RenderErrorContext, type RenderError } from "./render/RenderErrorContext";
import { RenderErrorPanel } from "./render/RenderErrorPanel";

import { LeftRail } from "./toc/LeftRail";
import { useAnnotations } from "./annotation/useAnnotations";

const token = new URLSearchParams(window.location.search).get("token") ?? "";
const sessionId = window.location.pathname.split("/").filter(Boolean).at(-1) ?? "";

type DeliveryState = { status: "idle" | "delivered" | "failed"; error?: string };
type SendBody = { kind: "chat" | "annotated-feedback"; message: string; filePath?: string; annotations?: LiteAnnotation[] };
type ResizePane = "left" | "right";
type ThemeMode = "system" | "light" | "dark";

const MAIN_PLAN_FILE = "requirements/index.md";
const MIN_LEFT_WIDTH = 150;
const MAX_LEFT_WIDTH = 440;
const MIN_RIGHT_WIDTH = 280;
const MAX_RIGHT_WIDTH = 640;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function storedPaneWidth(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function storedTheme(): ThemeMode {
  const value = window.localStorage.getItem("planalot:theme");
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function App() {
  const [session, setSession] = useState<PlanSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<PlanFileEntry[]>([]);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState(MAIN_PLAN_FILE);
  const [selectedContent, setSelectedContent] = useState("");
  const [leftWidth, setLeftWidth] = useState(() => storedPaneWidth("planalot:leftWidth", 220));
  const [rightWidth, setRightWidth] = useState(() => storedPaneWidth("planalot:rightWidth", 390));
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => storedTheme());
  const [copiedPlanId, setCopiedPlanId] = useState(false);

  // Harness routing UI state.
  const [chosenTarget, setChosenTarget] = useState<string | null>(null); // null = auto-resolve
  const [delivery, setDelivery] = useState<DeliveryState>({ status: "idle" });
  const lastSendRef = useRef<SendBody | null>(null);

  // Render-error collection (reset on every plan edit; blocks re-report).
  const [renderErrors, setRenderErrors] = useState<Record<string, RenderError>>({});
  const [reported, setReported] = useState<Set<string>>(new Set());

  const shellRef = useRef<HTMLElement>(null);
  const planRef = useRef<HTMLElement>(null);
  const selectedFileRef = useRef(selectedFile);
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);

  useEffect(() => {
    window.localStorage.setItem("planalot:leftWidth", String(leftWidth));
    leftWidthRef.current = leftWidth;
  }, [leftWidth]);

  useEffect(() => {
    window.localStorage.setItem("planalot:rightWidth", String(rightWidth));
    rightWidthRef.current = rightWidth;
  }, [rightWidth]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    window.localStorage.setItem("planalot:theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void fetchSession();
    const source = new EventSource(`/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`);
    const update = (event: MessageEvent<string>) => handleEvent(JSON.parse(event.data) as ServerEvent);
    for (const name of [
      "plan.changed",
      "feedback.sent",
      "feedback.requested",
      "feedback.answered",
      "plan.accepted",
      "plan.build",
      "session.status",
      "feedback.failed",
      "harness.presence",
    ]) {
      source.addEventListener(name, update);
    }
    source.onerror = () => setError("Live connection interrupted. Reconnecting…");
    return () => source.close();
  }, []);

  async function fetchSession() {
    const response = await fetch(`/sessions/${sessionId}?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const nextSession = (await response.json()) as PlanSession;
    setSession(nextSession);
    setSelectedContent(nextSession.currentPlanText);
    await fetchFiles();
    await fetchPlans();
    setError(null);
  }

  async function fetchFiles() {
    const response = await fetch(`/plans/${sessionId}/files?token=${encodeURIComponent(token)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { files: PlanFileEntry[] };
    setFiles(data.files);
  }

  async function fetchPlans() {
    const response = await fetch(`/plans?includeExpired=true&limit=100&token=${encodeURIComponent(token)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { plans: PlanSummary[] };
    setPlans(data.plans);
  }

  async function chooseFile(path: string) {
    selectedFileRef.current = path;
    setSelectedFile(path);
    if (path === MAIN_PLAN_FILE && session) {
      setSelectedContent(session.currentPlanText);
      return;
    }
    const response = await fetch(`/plans/${sessionId}/files/${encodeURIComponent(path)}?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const data = (await response.json()) as { content: string };
    setSelectedContent(data.content);
    setError(null);
  }

  function choosePlan(planId: string) {
    if (planId === sessionId) return;
    window.location.assign(`/s/${planId}?token=${encodeURIComponent(token)}`);
  }

  async function copyPlanId(planId: string) {
    await navigator.clipboard.writeText(planId);
    setCopiedPlanId(true);
    window.setTimeout(() => setCopiedPlanId(false), 1200);
  }

  function handleEvent(event: ServerEvent) {
    if (event.type === "feedback.failed") {
      setDelivery({ status: "failed", error: event.error });
      return;
    }
    setError(null);
    setSession((current) => {
      if (!current) return current;
      if (event.type === "plan.changed") {
        if (selectedFileRef.current === MAIN_PLAN_FILE) setSelectedContent(event.planText);
        return {
          ...current,
          currentPlanText: event.planText,
          currentPlanHash: event.hash,
          versions: [...current.versions, event.version],
          status: "plan-updated",
        };
      }
      if (event.type === "harness.presence") {
        const next: PlanSession = { ...current, harnesses: event.harnesses };
        if (event.targetHarnessId) next.targetHarnessId = event.targetHarnessId;
        else delete next.targetHarnessId;
        if (event.editLease) next.editLease = event.editLease;
        else delete next.editLease;
        return next;
      }
      if (event.type === "feedback.sent" || event.type === "plan.accepted" || event.type === "plan.build") {
        return current;
      }
      if (event.type === "feedback.requested") {
        return { ...current, feedbackRequests: [...current.feedbackRequests, event.request] };
      }
      if (event.type === "feedback.answered") {
        return {
          ...current,
          feedbackRequests: current.feedbackRequests.map((request) =>
            request.id === event.request.id ? event.request : request
          ),
        };
      }
      if (event.type === "session.status") {
        return { ...current, status: event.status };
      }
      return current;
    });
  }

  const selectedEntry = useMemo(() => files.find((file) => file.path === selectedFile), [files, selectedFile]);
  const selectedKind = selectedEntry?.type ?? "markdown";
  const blocks = useMemo(() => parseMarkdownBlocks(selectedContent), [selectedContent]);
  const pendingRequests = useMemo(
    () => session?.feedbackRequests.filter((r) => r.status === "requested") ?? [],
    [session?.feedbackRequests]
  );
  const latestVersion = session?.versions.at(-1);

  const { annotations, toolbar, popover, panel } = useAnnotations({
    containerRef: planRef,
    planText: selectedContent,
    sessionId,
  });

  // ── Render-error wiring ──────────────────────────────────────────────────
  const reportRenderError = useCallback((err: RenderError) => {
    setRenderErrors((prev) => ({ ...prev, [err.blockId]: err }));
  }, []);
  const clearRenderError = useCallback((blockId: string) => {
    setRenderErrors((prev) => {
      if (!(blockId in prev)) return prev;
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
  }, []);
  const renderErrorApi = useMemo(() => ({ report: reportRenderError, clear: clearRenderError }), [reportRenderError, clearRenderError]);

  // Reset render errors + reported markers whenever the plan text changes;
  // blocks re-report on the next render.
  useEffect(() => {
    setRenderErrors({});
    setReported(new Set());
  }, [selectedContent]);

  // ── Delivery ─────────────────────────────────────────────────────────────
  async function deliver(body: SendBody): Promise<boolean> {
    lastSendRef.current = body;
    const targetHarnessId = chosenTarget ?? session?.targetHarnessId ?? undefined;
    const response = await post("feedback", { ...body, ...(targetHarnessId ? { targetHarnessId } : {}) });
    if (!response.ok) {
      setDelivery({ status: "failed", error: "Request failed." });
      return false;
    }
    const data = (await response.json()) as { delivered?: boolean };
    if (data.delivered) {
      setDelivery({ status: "delivered" });
      return true;
    }
    setDelivery({ status: "failed", error: "No connected harness to deliver to." });
    return false;
  }

  async function sendFeedback() {
    const text = draft.trim();
    if (!text && annotations.length === 0) return;
    const sentAnnotations: LiteAnnotation[] | undefined = annotations.length > 0 ? annotations : undefined;
    const body: SendBody = {
      kind: sentAnnotations ? "annotated-feedback" : "chat",
      message: text || "(annotated feedback)",
      filePath: selectedFile,
      ...(sentAnnotations ? { annotations: sentAnnotations } : {}),
    };
    const ok = await deliver(body);
    if (ok) setDraft("");
  }

  function retryLastSend() {
    if (lastSendRef.current) void deliver(lastSendRef.current);
  }

  async function reportError(err: RenderError) {
    const fence = err.kind || "";
    const message =
      `Planalot could not render a ${err.kind} block in ${session?.planFile ?? "the plan"}. ` +
      `Please fix the plan so it renders.\n\nError: ${err.message}\n\nSource:\n\`\`\`${fence}\n${err.source}\n\`\`\``;
    const ok = await deliver({ kind: "chat", message });
    if (ok) setReported((prev) => new Set(prev).add(err.blockId));
  }

  async function post(action: string, body: unknown = {}) {
    const response = await fetch(`/sessions/${sessionId}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) setError(await response.text());
    return response;
  }

  // Persistently designate the driver harness (server broadcasts presence back).
  async function setDriver(harnessId: string) {
    const response = await fetch(`/plans/${sessionId}/harnesses/main`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ harnessId }),
    });
    if (!response.ok) setError(await response.text());
  }

  function startResize(pane: ResizePane, event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = leftWidthRef.current;
    const startRight = rightWidthRef.current;
    const shell = shellRef.current;
    let frame = 0;
    let nextWidth = pane === "left" ? startLeft : startRight;

    const applyWidth = () => {
      frame = 0;
      if (!shell) return;
      if (pane === "left") {
        shell.style.setProperty("--left-pane-width", `${nextWidth}px`);
      } else {
        shell.style.setProperty("--right-pane-width", `${nextWidth}px`);
      }
    };

    function move(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX;
      nextWidth =
        pane === "left"
          ? clamp(startLeft + delta, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH)
          : clamp(startRight - delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH);
      if (pane === "left") leftWidthRef.current = nextWidth;
      else rightWidthRef.current = nextWidth;
      if (frame === 0) frame = window.requestAnimationFrame(applyWidth);
    }

    function stop() {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("isResizingLayout");
      if (pane === "left") setLeftWidth(leftWidthRef.current);
      else setRightWidth(rightWidthRef.current);
    }

    document.body.classList.add("isResizingLayout");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  const renderErrorList = useMemo(() => Object.values(renderErrors), [renderErrors]);
  const shellStyle = useMemo(() => ({
    "--left-pane-width": leftCollapsed ? "0px" : `${leftWidth}px`,
    "--left-handle-width": leftCollapsed ? "0px" : "3px",
    "--right-handle-width": rightCollapsed ? "0px" : "3px",
    "--right-pane-width": rightCollapsed ? "0px" : `${rightWidth}px`,
  }) as React.CSSProperties, [leftCollapsed, leftWidth, rightCollapsed, rightWidth]);

  if (!session) {
    return <main className="loading">{error ?? "Loading planalot…"}</main>;
  }

  return (
    <main className="shell" style={shellStyle} ref={shellRef as React.Ref<HTMLElement>}>
      {!leftCollapsed ? (
        <LeftRail
          blocks={blocks}
          containerRef={planRef}
          currentPlanId={session.id}
          files={files}
          selectedFile={selectedFile}
          plans={plans}
          onFileSelect={(path) => void chooseFile(path)}
          onPlanSelect={choosePlan}
        />
      ) : null}
      {!leftCollapsed ? (
        <div
          className="resizeDivider resizeDivider--left"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize left rail"
          onPointerDown={(event) => startResize("left", event)}
        />
      ) : null}

      <section className="contentPane">
        <div className="contentToolbar">
          <div className="contentToolbar__identity">
            <h1>{session.planFile}</h1>
            <button
              type="button"
              className="planIdButton"
              title={`Copy plan id. Content hash: ${session.currentPlanHash}`}
              aria-label={`Copy plan id ${session.id}`}
              onClick={() => void copyPlanId(session.id)}
            >
              <span>{session.id}</span>
              {copiedPlanId ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
            </button>
          </div>
          <div className="contentToolbar__actions">
            <ThemeControl value={theme} onChange={setTheme} />
          <button
            type="button"
            className={leftCollapsed ? "paneToggle paneToggle--collapsed" : "paneToggle"}
            title={leftCollapsed ? "Show left rail" : "Hide left rail"}
            aria-label={leftCollapsed ? "Show left rail" : "Hide left rail"}
            aria-pressed={!leftCollapsed}
            onClick={() => setLeftCollapsed((value) => !value)}
          >
            {leftCollapsed ? <PanelLeftOpen aria-hidden="true" size={17} /> : <PanelLeftClose aria-hidden="true" size={17} />}
          </button>
          <button
            type="button"
            className={rightCollapsed ? "paneToggle paneToggle--collapsed" : "paneToggle"}
            title={rightCollapsed ? "Show review rail" : "Hide review rail"}
            aria-label={rightCollapsed ? "Show review rail" : "Hide review rail"}
            aria-pressed={!rightCollapsed}
            onClick={() => setRightCollapsed((value) => !value)}
          >
            {rightCollapsed ? <PanelRightOpen aria-hidden="true" size={17} /> : <PanelRightClose aria-hidden="true" size={17} />}
          </button>
          </div>
        </div>
        {latestVersion?.modifications.length ? <ModificationTrail request={latestVersion} /> : null}

        {selectedKind === "html" ? (
          <iframe className="htmlPreview" sandbox="" srcDoc={selectedContent} title={selectedFile} />
        ) : (
          <RenderErrorContext.Provider value={renderErrorApi}>
            <article className="planSurface" ref={planRef as React.Ref<HTMLElement>}>
              {blocks.map((block) => <BlockRenderer key={block.id} block={block} />)}
            </article>
          </RenderErrorContext.Provider>
        )}

        {toolbar}
        {popover}
      </section>

      {!rightCollapsed ? (
        <div
          className="resizeDivider resizeDivider--right"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize review rail"
          onPointerDown={(event) => startResize("right", event)}
        />
      ) : null}

      {!rightCollapsed ? <aside className="rightRail">
        <header className="rightRailHeader">
          <div className="sessionMeta" aria-label="Session metadata">
            <span title="Runtime that created or opened this plan.">runtime: {session.runtime}</span>
            <span title="Current live review session state.">status: {session.status}</span>
            <span title="Current plan version. v0 is the initial version before any plan update.">v{latestVersion?.version ?? 0}</span>
          </div>
        </header>
        {error ? <p className="error">{error}</p> : null}

        <HarnessBar
          harnesses={session.harnesses ?? []}
          resolved={session.targetHarnessId}
          chosen={chosenTarget}
          onChoose={setChosenTarget}
          editLease={session.editLease}
          onSetDriver={(id) => void setDriver(id)}
        />

        <div className="decisionRow">
          <button type="button" className="ghost" onClick={() => void post("accept")}>Accept</button>
          <button type="button" onClick={() => void post("build")}>Build</button>
        </div>

        {pendingRequests.map((request) => (
          <FeedbackRequestCard
            key={request.id}
            request={request}
            onSubmit={(answers) => post("feedback-answered", { requestId: request.id, answers })}
          />
        ))}

        {renderErrorList.length ? (
          <RenderErrorPanel errors={renderErrorList} reported={reported} onReport={(e) => void reportError(e)} />
        ) : null}

        {panel}

        <textarea
          className="draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Send plan feedback or a chat message…"
        />
        <button type="button" onClick={() => void sendFeedback()}>Send feedback</button>
        <DeliveryStatus delivery={delivery} onRetry={retryLastSend} />
        <p className="hint">
          Feedback routes to the selected harness. A failed send can be retried or re-targeted above.
        </p>
      </aside> : null}
    </main>
  );
}

function ThemeControl({ value, onChange }: { value: ThemeMode; onChange: (value: ThemeMode) => void }) {
  const modes: Array<{ value: ThemeMode; label: string; icon: React.ReactNode }> = [
    { value: "system", label: "Use system theme", icon: <Monitor aria-hidden="true" size={16} /> },
    { value: "light", label: "Use light theme", icon: <Sun aria-hidden="true" size={16} /> },
    { value: "dark", label: "Use dark theme", icon: <Moon aria-hidden="true" size={16} /> },
  ];

  return (
    <div className="themeControl" aria-label="Theme">
      {modes.map((mode) => (
        <button
          key={mode.value}
          type="button"
          className={mode.value === value ? "themeButton themeButton--active" : "themeButton"}
          title={mode.label}
          aria-label={mode.label}
          aria-pressed={mode.value === value}
          onClick={() => onChange(mode.value)}
        >
          {mode.icon}
        </button>
      ))}
    </div>
  );
}

function HarnessBar({
  harnesses,
  resolved,
  chosen,
  onChoose,
  editLease,
  onSetDriver,
}: {
  harnesses: HarnessPresence[];
  resolved: string | undefined;
  chosen: string | null;
  onChoose: (id: string | null) => void;
  editLease: PlanSession["editLease"];
  onSetDriver: (id: string) => void;
}) {
  if (harnesses.length === 0) {
    return <p className="harnessBar harnessBar--empty">No harness connected — sends will fail until one attaches.</p>;
  }
  const resolvedLabel = harnesses.find((h) => h.harnessId === resolved);
  const lockLabels = editLease
    ? editLease.holderHarnessIds.map((id) => harnesses.find((h) => h.harnessId === id)?.label ?? id)
    : [];
  return (
    <div className="harnessBar">
      <div className="harnessBar__roster">
        {harnesses.map((h) => (
          <span key={h.harnessId} className={`harnessChip harnessChip--${h.status}${h.isDriver ? " harnessChip--driver" : ""}`}>
            <span className={`harnessChip__dot harnessChip__dot--${h.status}`} aria-hidden="true" />
            <span className="harnessChip__name">{h.harnessType} · {h.label}</span>
            {h.status === "down" ? <span className="harnessChip__badge harnessChip__badge--down">down</span> : null}
            {h.isDriver ? (
              <span className="harnessChip__badge harnessChip__badge--driver">driver</span>
            ) : (
              <button
                type="button"
                className="harnessChip__make"
                onClick={() => onSetDriver(h.harnessId)}
                disabled={h.status !== "live"}
                title="Make this harness the plan driver"
              >
                make driver
              </button>
            )}
          </span>
        ))}
      </div>
      {editLease ? (
        <p className="harnessBar__lock">
          🔒 Locked — {lockLabels.join(", ")} {lockLabels.length > 1 ? "are" : "is"} editing this plan (feedback round)
        </p>
      ) : null}
      <div className="harnessBar__row">
        <label className="harnessBar__label">Send to</label>
        <select
          className="harnessBar__select"
          value={chosen ?? ""}
          onChange={(e) => onChoose(e.target.value || null)}
        >
          <option value="">
            Auto{resolvedLabel ? ` — ${resolvedLabel.harnessType} · ${resolvedLabel.label}` : ""}
          </option>
          {harnesses.map((h) => (
            <option key={h.harnessId} value={h.harnessId}>
              {h.harnessType} · {h.label}{h.status === "down" ? " (down)" : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DeliveryStatus({ delivery, onRetry }: { delivery: DeliveryState; onRetry: () => void }) {
  if (delivery.status === "delivered") {
    return <p className="deliveryOk">Delivered ✓</p>;
  }
  if (delivery.status === "failed") {
    return (
      <p className="error">
        Delivery failed: {delivery.error}{" "}
        <button type="button" className="ghost inline" onClick={onRetry}>Retry</button>
      </p>
    );
  }
  return null;
}

function FeedbackRequestCard({
  request,
  onSubmit,
}: {
  request: FeedbackQuestionRequest;
  onSubmit: (answers: FeedbackAnswer[]) => Promise<Response>;
}) {
  const [answers, setAnswers] = useState<Record<string, FeedbackAnswer>>({});

  function updateAnswer(questionId: string, patch: Partial<FeedbackAnswer>) {
    setAnswers((current) => ({
      ...current,
      [questionId]: { questionId, ...current[questionId], ...patch },
    }));
  }

  async function submit() {
    await onSubmit(Object.values(answers));
  }

  return (
    <div className="questionCard">
      <strong>Feedback requested</strong>
      {request.questions.map((question) => (
        <div key={question.id} className="questionBlock">
          <p>{question.prompt}{question.required ? " *" : ""}</p>
          {question.kind === "text" ? (
            <textarea
              onChange={(event) => updateAnswer(question.id, { text: event.target.value })}
              placeholder="Type your answer…"
            />
          ) : (
            <div className="suggestions">
              {question.suggestions?.map((suggestion) => {
                const selected = answers[question.id]?.selectedSuggestionIds?.includes(suggestion.id) ?? false;
                return (
                  <label key={suggestion.id} className={selected ? "suggestion selected" : "suggestion"}>
                    <input
                      type={question.kind === "multi-select" ? "checkbox" : "radio"}
                      name={question.id}
                      checked={selected}
                      onChange={(event) => {
                        const current = answers[question.id]?.selectedSuggestionIds ?? [];
                        const next =
                          question.kind === "multi-select"
                            ? event.target.checked
                              ? [...current, suggestion.id]
                              : current.filter((id) => id !== suggestion.id)
                            : [suggestion.id];
                        updateAnswer(question.id, { selectedSuggestionIds: next });
                      }}
                    />
                    <span>
                      <strong>{suggestion.label}</strong>
                      {suggestion.description}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <button type="button" onClick={() => void submit()}>Send answers</button>
    </div>
  );
}

function ModificationTrail({ request }: { request: NonNullable<PlanSession["versions"][number]> }) {
  return (
    <div className="trail">
      <strong>Latest modifications</strong>
      {request.modifications.map((modification) => (
        <div key={modification.id} className="trailItem">
          <span>{modification.type}</span>
          <small>after lines {modification.afterStartLine ?? "—"}-{modification.afterEndLine ?? "—"}</small>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
