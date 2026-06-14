/**
 * LeftRail — left-hand table of contents built from heading blocks.
 *
 * Prop interface (fixed — do not change):
 *
 *   interface LeftRailProps {
 *     blocks: MarkdownBlock[];
 *     containerRef: React.RefObject<HTMLElement | null>;
 *   }
 *
 * Behaviour:
 *   - Lists all heading blocks, indented by level.
 *   - Click → smooth-scrolls the plan surface to the matching [data-block-id].
 *   - IntersectionObserver scroll-spy keeps the active heading highlighted as
 *     the user scrolls. Observer is cleaned up on unmount and when blocks change.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FileText, FlaskConical, FolderGit2, FolderOpen, ListTree } from "lucide-react";
import type { MarkdownBlock, PlanFileEntry, PlanLayer, PlanSummary, ResearchSession } from "@planalot/shared";
import { INQUIRY_META, researchProgress } from "../research/status";
import "./rail.css";

type LeftRailView = "plan" | "all";

export interface LeftRailProps {
  blocks: MarkdownBlock[];
  containerRef: React.RefObject<HTMLElement | null>;
  currentPlanId: string;
  files: PlanFileEntry[];
  selectedFile: string;
  plans: PlanSummary[];
  research: ResearchSession[];
  selectedResearchId: string | null;
  onFileSelect: (path: string) => void;
  onPlanSelect: (planId: string) => void;
  onResearchSelect: (researchId: string) => void;
}

export function LeftRail({
  blocks,
  containerRef,
  currentPlanId,
  files,
  selectedFile,
  plans,
  research,
  selectedResearchId,
  onFileSelect,
  onPlanSelect,
  onResearchSelect,
}: LeftRailProps): React.ReactElement {
  const headings = useMemo(() => blocks.filter((b) => b.type === "heading"), [blocks]);
  const [view, setView] = useState<LeftRailView>("plan");
  const [filesOpen, setFilesOpen] = useState(true);
  const [layerOpen, setLayerOpen] = useState<Record<PlanLayer, boolean>>({
    requirements: true,
    design: true,
    tasks: true,
  });
  const [chaptersOpen, setChaptersOpen] = useState(true);
  const [researchOpen, setResearchOpen] = useState(true);
  const filesByLayer = useMemo(() => groupFilesByLayer(files), [files]);

  // ID of the currently-visible heading (scroll-spy).
  const [activeId, setActiveId] = useState<string | null>(null);

  // Keep a ref to the latest headings list so the observer callback closure
  // always sees the current list without needing to re-register the observer.
  const headingsRef = useRef(headings);
  headingsRef.current = headings;

  // Scroll-spy: observe all heading wrapper elements inside containerRef.
  // When the topmost intersecting heading changes we update activeId.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || headings.length === 0) return;

    // Track which headings are currently intersecting (may be multiple).
    const intersecting = new Set<string>();

    // The containerRef points to the planSurface <article>, which is NOT the
    // scrolling element (the parent .contentPane section is). We walk up to find
    // the nearest scrolling ancestor to use as the IntersectionObserver root.
    // Falling back to null (viewport) is always safe.
    function findScrollParent(el: HTMLElement): HTMLElement | null {
      let node: HTMLElement | null = el.parentElement;
      while (node) {
        const style = window.getComputedStyle(node);
        if (style.overflow === "auto" || style.overflow === "scroll" ||
            style.overflowY === "auto" || style.overflowY === "scroll") {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    }
    const scrollRoot = findScrollParent(container);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.blockId;
          if (!id) continue;
          if (entry.isIntersecting) {
            intersecting.add(id);
          } else {
            intersecting.delete(id);
          }
        }

        // Pick the first heading (by document order) that is intersecting.
        // If nothing is intersecting, keep the last active heading so the
        // rail doesn't go blank while scrolling between sections.
        const currentHeadings = headingsRef.current;
        for (const h of currentHeadings) {
          if (intersecting.has(h.id)) {
            setActiveId(h.id);
            return;
          }
        }
        // Nothing intersecting — find the last heading whose block top is
        // above the middle of the scroll root (i.e. the user has scrolled
        // past it). This keeps the rail active during long prose gaps.
        const rootEl = scrollRoot ?? document.documentElement;
        const rootRect = rootEl.getBoundingClientRect();
        const midpoint = rootRect.top + rootRect.height * 0.5;
        let lastAbove: string | null = null;
        for (const h of currentHeadings) {
          const el = container.querySelector<HTMLElement>(`[data-block-id="${h.id}"]`);
          if (!el) continue;
          if (el.getBoundingClientRect().top < midpoint) {
            lastAbove = h.id;
          }
        }
        if (lastAbove !== null) setActiveId(lastAbove);
      },
      {
        // Use the nearest scrolling ancestor so intersection is relative to
        // what the user actually sees in the plan pane, not the window.
        root: scrollRoot,
        // A heading is "active" once it enters the top 30% of the scroll pane.
        rootMargin: "0px 0px -70% 0px",
        threshold: 0,
      }
    );

    for (const h of headings) {
      const el = container.querySelector<HTMLElement>(`[data-block-id="${h.id}"]`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
    // Re-run when blocks change (the heading list may have changed entirely).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, containerRef]);

  const handleClick = useCallback(
    (headingId: string) => {
      const container = containerRef.current;
      if (!container) return;
      const target = container.querySelector<HTMLElement>(`[data-block-id="${headingId}"]`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(headingId);
    },
    [containerRef]
  );

  return (
    <aside className="leftRail" aria-label="Plan navigation">
      <header className="leftRailHeader">
        <button
          type="button"
          className={view === "plan" ? "leftRailTab leftRailTab--active" : "leftRailTab"}
          title="Current plan"
          aria-label="Current plan"
          aria-pressed={view === "plan"}
          onClick={() => setView("plan")}
        >
          <FolderGit2 aria-hidden="true" size={15} />
          <span>Plan</span>
        </button>
        <button
          type="button"
          className={view === "all" ? "leftRailTab leftRailTab--active" : "leftRailTab"}
          title="All plans"
          aria-label="All plans"
          aria-pressed={view === "all"}
          onClick={() => setView("all")}
        >
          <ListTree aria-hidden="true" size={15} />
          <span>All Plans</span>
        </button>
      </header>

      {view === "plan" ? (
        <div className="leftRailBody">
          <RailSection title="Files" open={filesOpen} onToggle={() => setFilesOpen((value) => !value)}>
            <div className="leftRailLayerList" aria-label="Plan files">
              {PLAN_LAYER_ORDER.map((layer) => (
                <div className="leftRailLayer" key={layer}>
                  <button
                    type="button"
                    className="leftRailLayerHeader"
                    aria-expanded={layerOpen[layer]}
                    onClick={() => setLayerOpen((current) => ({ ...current, [layer]: !current[layer] }))}
                  >
                    {layerOpen[layer] ? <ChevronDown aria-hidden="true" size={13} /> : <ChevronRight aria-hidden="true" size={13} />}
                    <FolderOpen aria-hidden="true" size={13} />
                    <span>{LAYER_LABELS[layer]}</span>
                  </button>
                  {layerOpen[layer] ? (
                    <nav className="leftRailList" aria-label={`${LAYER_LABELS[layer]} files`}>
                      {filesByLayer[layer].length > 0 ? (
                        filesByLayer[layer].map((file) => (
                          <FileButton
                            key={file.path}
                            file={file}
                            selected={file.path === selectedFile}
                            onSelect={onFileSelect}
                          />
                        ))
                      ) : (
                        <p className="leftRailEmpty leftRailEmpty--compact">No files</p>
                      )}
                    </nav>
                  ) : null}
                </div>
              ))}
            </div>
          </RailSection>

          <RailSection title="Research" open={researchOpen} onToggle={() => setResearchOpen((value) => !value)}>
            {research.length > 0 ? (
              <div className="leftRailResearch">
                {research.map((session) => {
                  const { resolved, total } = researchProgress(session);
                  const selected = session.id === selectedResearchId;
                  return (
                    <div key={session.id}>
                      <button
                        type="button"
                        className={selected ? "railResearch__head railResearch__head--active" : "railResearch__head"}
                        onClick={() => onResearchSelect(session.id)}
                        title={session.title}
                      >
                        <FlaskConical className="railResearch__icon" aria-hidden="true" size={13} />
                        <span className="railResearch__name">{session.title}</span>
                        <span className="railResearch__count">{resolved}/{total}</span>
                      </button>
                      <div className="railResearch__inquiries">
                        {session.inquiries.map((inquiry) => {
                          const meta = INQUIRY_META[inquiry.status];
                          return (
                            <div
                              className={`railInquiry railInquiry--${inquiry.status}`}
                              key={inquiry.id}
                              title={`${inquiry.title} — ${meta.label}`}
                            >
                              <span className="railInquiry__glyph" style={{ color: meta.colorVar }} aria-hidden="true">{meta.glyph}</span>
                              <span className="railInquiry__text">{inquiry.title}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="leftRailEmpty">No research sessions.</p>
            )}
          </RailSection>

          <RailSection title="Chapters" open={chaptersOpen} onToggle={() => setChaptersOpen((value) => !value)}>
            {headings.length > 0 ? (
              <nav className="leftRailList" aria-label="Chapter outline">
                {headings.map((heading) => {
                  const level = heading.level ?? 1;
                  const paddingLeft = (level - 1) * 12 + 12;
                  const isActive = heading.id === activeId;
                  return (
                    <button
                      key={heading.id}
                      type="button"
                      className={`leftRailItem${isActive ? " leftRailItem--active" : ""}`}
                      data-heading-id={heading.id}
                      data-level={level}
                      style={{ paddingLeft: `${paddingLeft}px` }}
                      onClick={() => handleClick(heading.id)}
                      title={heading.content}
                    >
                      <span className="leftRailItem__marker" aria-hidden="true" />
                      <span className="leftRailItem__text">{heading.content}</span>
                    </button>
                  );
                })}
              </nav>
            ) : (
              <p className="leftRailEmpty">No headings in this file.</p>
            )}
          </RailSection>
        </div>
      ) : (
        <nav className="leftRailBody leftRailList" aria-label="All plans">
          {plans.length > 0 ? (
            plans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                className={plan.id === currentPlanId ? "leftRailPlan leftRailPlan--active" : "leftRailPlan"}
                onClick={() => onPlanSelect(plan.id)}
                title={plan.workspacePath}
              >
                <span className="leftRailPlan__name">{plan.name}</span>
                <span className="leftRailPlan__meta">{plan.effectiveStatus} · {plan.files.length} files</span>
              </button>
            ))
          ) : (
            <p className="leftRailEmpty">No plans found.</p>
          )}
        </nav>
      )}
    </aside>
  );
}

const PLAN_LAYER_ORDER: readonly PlanLayer[] = ["requirements", "design", "tasks"];
const LAYER_LABELS: Record<PlanLayer, string> = {
  requirements: "Requirements",
  design: "Design",
  tasks: "Tasks",
};

function groupFilesByLayer(files: PlanFileEntry[]): Record<PlanLayer, PlanFileEntry[]> {
  return {
    requirements: files.filter((file) => file.layer === "requirements" || file.path.startsWith("requirements/")),
    design: files.filter((file) => file.layer === "design" || file.path.startsWith("design/")),
    tasks: files.filter((file) => file.layer === "tasks" || file.path.startsWith("tasks/")),
  };
}

function FileButton({
  file,
  selected,
  onSelect,
}: {
  file: PlanFileEntry;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={selected ? "leftRailItem leftRailItem--active" : "leftRailItem"}
      onClick={() => onSelect(file.path)}
      title={file.purpose || file.path}
    >
      {file.type === "html" ? (
        <FileCode2 className="leftRailItem__fileIcon" aria-hidden="true" size={14} />
      ) : (
        <FileText className="leftRailItem__fileIcon" aria-hidden="true" size={14} />
      )}
      <span className="leftRailItem__text">{fileName(file.path)}</span>
    </button>
  );
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function RailSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="leftRailSection">
      <button
        type="button"
        className="leftRailSectionHeader"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
        <span>{title}</span>
      </button>
      {open ? <div className="leftRailSectionBody">{children}</div> : null}
    </section>
  );
}
