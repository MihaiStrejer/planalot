/**
 * useAnnotations — manages annotation state and exposes rendered pieces.
 *
 * FIXED SIGNATURE (do not change — T4 fills the implementation):
 *
 *   function useAnnotations(opts: UseAnnotationsOptions): UseAnnotationsResult
 *
 *   interface UseAnnotationsOptions {
 *     containerRef: React.RefObject<HTMLElement | null>;
 *     planText: string;
 *     sessionId: string;
 *     onSend?: () => void;
 *   }
 *
 *   interface UseAnnotationsResult {
 *     annotations: LiteAnnotation[];
 *     // React nodes to render in the parent — null when there is nothing to show.
 *     toolbar: React.ReactNode;   // <AnnotationToolbar> overlay, positioned absolutely
 *     popover: React.ReactNode;   // <CommentPopover> overlay, positioned absolutely
 *     panel: React.ReactNode;     // <AnnotationPanel> for the right rail
 *   }
 */

import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { LiteAnnotation } from "@planalot/shared";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { CommentPopover } from "./CommentPopover";
import { AnnotationPanel } from "./AnnotationPanel";
import "./annotation.css";

export interface UseAnnotationsOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  planText: string;
  sessionId: string;
  onSend?: () => void;
}

export interface UseAnnotationsResult {
  annotations: LiteAnnotation[];
  /** Floating toolbar — render as a direct child of the plan pane overlay. */
  toolbar: React.ReactNode;
  /** Comment popover — render as a direct child of the plan pane overlay. */
  popover: React.ReactNode;
  /** Annotation card list — render inside the right rail. */
  panel: React.ReactNode;
}

/** Orphan tracking — kept separate from LiteAnnotation to avoid mutating the shared type. */
type OrphanSet = Set<string>;

const QUICK_LABELS = ["unclear", "wrong", "tighten", "expand", "remove"];

// Surrounding context length (chars) captured as prefix/suffix for disambiguation.
const CONTEXT_LEN = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadFromStorage(sessionId: string): LiteAnnotation[] {
  try {
    const raw = localStorage.getItem(`planalot:annotations:${sessionId}`);
    if (!raw) return [];
    return JSON.parse(raw) as LiteAnnotation[];
  } catch {
    return [];
  }
}

function saveToStorage(sessionId: string, annotations: LiteAnnotation[]): void {
  try {
    localStorage.setItem(`planalot:annotations:${sessionId}`, JSON.stringify(annotations));
  } catch {
    // quota exceeded or private browsing — silently ignore
  }
}

/**
 * Walk all text nodes under `root` and collect them with their cumulative offset.
 * Returns an array of { node, start, end } sorted by document order.
 */
function collectTextNodes(root: HTMLElement): Array<{ node: Text; start: number; end: number }> {
  const result: Array<{ node: Text; start: number; end: number }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    const textNode = n as Text;
    const len = textNode.nodeValue?.length ?? 0;
    result.push({ node: textNode, start: offset, end: offset + len });
    offset += len;
  }
  return result;
}

/**
 * Search for `needle` in the full text of `root` using prefix/suffix to
 * disambiguate if there are multiple occurrences. Returns a Range or null.
 *
 * Strategy:
 *  1. Build the full text string by concatenating all text-node content.
 *  2. Find all positions of `needle` in that string.
 *  3. If prefix/suffix provided, pick the position whose surrounding context
 *     best matches. Otherwise pick the first occurrence.
 *  4. Map the character offset back to a DOM Range.
 */
function findTextRange(
  root: HTMLElement,
  needle: string,
  prefix?: string,
  suffix?: string,
): Range | null {
  if (!needle) return null;

  const nodes = collectTextNodes(root);
  const fullText = nodes.map((t) => t.node.nodeValue ?? "").join("");

  // Gather all occurrence positions.
  const positions: number[] = [];
  let search = 0;
  while (true) {
    const idx = fullText.indexOf(needle, search);
    if (idx === -1) break;
    positions.push(idx);
    search = idx + 1;
  }
  if (positions.length === 0) return null;

  let startOffset: number;
  if (positions.length === 1 || (!prefix && !suffix)) {
    startOffset = positions[0]!;
  } else {
    // Score each position by how well context matches.
    let bestScore = -1;
    let bestPos = positions[0]!;
    for (const pos of positions) {
      let score = 0;
      if (prefix) {
        const actualPrefix = fullText.slice(Math.max(0, pos - prefix.length), pos);
        if (actualPrefix === prefix) score += 2;
        else if (actualPrefix.endsWith(prefix.slice(-8))) score += 1;
      }
      if (suffix) {
        const end = pos + needle.length;
        const actualSuffix = fullText.slice(end, end + suffix.length);
        if (actualSuffix === suffix) score += 2;
        else if (actualSuffix.startsWith(suffix.slice(0, 8))) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }
    startOffset = bestPos;
  }

  const endOffset = startOffset + needle.length;

  // Map character offsets back to DOM nodes.
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;

  for (const { node, start, end } of nodes) {
    if (startNode === null && startOffset >= start && startOffset < end) {
      startNode = node;
      startNodeOffset = startOffset - start;
    }
    if (endNode === null && endOffset > start && endOffset <= end) {
      endNode = node;
      endNodeOffset = endOffset - start;
    }
    if (startNode !== null && endNode !== null) break;
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startNodeOffset);
  range.setEnd(endNode, endNodeOffset);
  return range;
}

/** CSS class + selector identifying the transient "pending" selection object. */
const PENDING_CLASS = "annotation-highlight--pending";
const PENDING_SELECTOR = `mark.${PENDING_CLASS}`;

/**
 * Unwrap every <mark> matching `selector` under `root`, moving its children
 * back into the surrounding text and normalizing the split text nodes.
 */
function unwrapMarks(root: HTMLElement, selector: string): void {
  const marks = Array.from(root.querySelectorAll(selector));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    // Move each child of the mark to before the mark in the parent.
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  }
  // Normalize text nodes that were split during a previous surroundContents.
  root.normalize();
}

/**
 * Remove all annotation marks (committed + pending) before re-anchoring,
 * to avoid nested or duplicate marks.
 */
function clearHighlightMarks(root: HTMLElement): void {
  unwrapMarks(root, "mark.annotation-highlight");
}

/** Remove only the transient pending-selection object. */
function clearPendingMark(root: HTMLElement): void {
  unwrapMarks(root, PENDING_SELECTOR);
}

/**
 * Wrap the portion of `range` falling inside each intersected text node in its
 * OWN <mark>, leaving all element structure (headings, list items, inline tags)
 * exactly in place. This is the only safe way to highlight a selection that
 * crosses element boundaries — wrapping the whole range in a single <mark>
 * forces `surroundContents` to fail and the extract/reinsert fallback to tear
 * block elements apart. Returns the marks created, in document order.
 *
 * `makeMark` is called once per slice so each caller can stamp its own
 * classes/dataset on every fragment.
 */
function wrapRangeWithMarks(range: Range, makeMark: () => HTMLElement): HTMLElement[] {
  const rootNode =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!rootNode) return [];

  // Collect every text-node slice up front; wrapping mutates the tree, so we
  // must not be walking it while we edit it.
  const slices: Array<{ node: Text; start: number; end: number }> = [];
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    const node = n as Text;
    if (!range.intersectsNode(node)) continue;
    const len = node.nodeValue?.length ?? 0;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : len;
    if (end <= start) continue;
    slices.push({ node, start, end });
  }

  const marks: HTMLElement[] = [];
  // Wrap last-to-first so splitting a later node never shifts an earlier slice.
  for (let i = slices.length - 1; i >= 0; i--) {
    const { node, start, end } = slices[i]!;
    const sliceRange = document.createRange();
    sliceRange.setStart(node, start);
    sliceRange.setEnd(node, end);
    const mark = makeMark();
    // A range confined to a single text node can always be surrounded.
    sliceRange.surroundContents(mark);
    marks.unshift(mark);
  }
  return marks;
}

/**
 * Wrap `range` as the persistent "pending" selection object
 * that the toolbar anchors to and that survives loss of the native selection.
 */
function wrapPendingMark(range: Range): void {
  wrapRangeWithMarks(range, () => {
    const mark = document.createElement("mark");
    mark.className = `annotation-highlight ${PENDING_CLASS}`;
    mark.dataset.pendingSelection = "1";
    return mark;
  });
}

/**
 * Live bounding rect of the pending-selection mark(s) in viewport
 * coordinates, recomputed on scroll/resize so the toolbar tracks the text.
 * Returns null when no pending mark is present.
 */
function pendingMarkRect(root: HTMLElement): DOMRect | null {
  const marks = Array.from(root.querySelectorAll(PENDING_SELECTOR));
  if (marks.length === 0) return null;
  const rects = marks.map((m) => m.getBoundingClientRect());
  const top = Math.min(...rects.map((r) => r.top));
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAnnotations(opts: UseAnnotationsOptions): UseAnnotationsResult {
  const { containerRef, planText, sessionId } = opts;

  const [annotations, setAnnotations] = useState<LiteAnnotation[]>(() =>
    loadFromStorage(sessionId)
  );
  const [orphans, setOrphans] = useState<OrphanSet>(new Set());

  // Selection state for the toolbar.
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);
  const [pendingSelection, setPendingSelection] = useState<{
    originalText: string;
    prefix: string;
    suffix: string;
    blockId?: string;
  } | null>(null);

  // Popover state — which annotation is being commented (undefined = closed).
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | undefined>(undefined);
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);

  // ---------------------------------------------------------------------------
  // Persist on change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    saveToStorage(sessionId, annotations);
  }, [annotations, sessionId]);

  // ---------------------------------------------------------------------------
  // Selection capture
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function onMouseUp() {
      // Small delay so the browser has committed the selection.
      setTimeout(() => {
        const cont = containerRef.current;
        if (!cont) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          clearPendingMark(cont);
          setSelectionRect(null);
          setPendingSelection(null);
          return;
        }

        const range = sel.getRangeAt(0);
        const originalText = sel.toString().trim();
        if (!originalText || !cont.contains(range.commonAncestorContainer)) {
          clearPendingMark(cont);
          setSelectionRect(null);
          setPendingSelection(null);
          return;
        }

        // Determine which block this selection is in.
        let blockId: string | undefined;
        let ancestor: Node | null = range.commonAncestorContainer;
        while (ancestor && ancestor !== cont) {
          if (ancestor instanceof HTMLElement && ancestor.dataset.blockId) {
            blockId = ancestor.dataset.blockId;
            break;
          }
          ancestor = ancestor.parentNode;
        }

        // Capture surrounding context for prefix/suffix disambiguation, anchored
        // to the *selected* occurrence rather than the first textual match — so
        // repeated phrases highlight where the user actually selected.
        const nodes = collectTextNodes(cont);
        const fullText = nodes.map((t) => t.node.nodeValue ?? "").join("");
        let approxStart = -1;
        for (const { node, start } of nodes) {
          if (node === range.startContainer) {
            approxStart = start + range.startOffset;
            break;
          }
        }
        let idx =
          approxStart >= 0
            ? fullText.indexOf(originalText, Math.max(0, approxStart - originalText.length))
            : fullText.indexOf(originalText);
        if (idx === -1) idx = fullText.indexOf(originalText);
        const prefix = idx >= 0 ? fullText.slice(Math.max(0, idx - CONTEXT_LEN), idx) : "";
        const suffix = idx >= 0
          ? fullText.slice(idx + originalText.length, idx + originalText.length + CONTEXT_LEN)
          : "";

        // Materialize the selection as a persistent object by wrapping the live
        // range directly, then drop the native selection. Wrapping the actual
        // range (rather than re-searching for the text) is robust: it always
        // succeeds for whatever the user selected, including cross-block ranges.
        wrapPendingMark(range);
        sel.removeAllRanges();

        const rect = pendingMarkRect(cont);
        if (!rect) {
          clearPendingMark(cont);
          setSelectionRect(null);
          setPendingSelection(null);
          return;
        }
        setSelectionRect(rect);
        setPendingSelection({
          originalText,
          prefix,
          suffix,
          ...(blockId !== undefined ? { blockId } : {}),
        });
      }, 10);
    }

    // Any new mousedown that isn't on the toolbar/popover starts fresh: tear
    // down the pending object so a new drag begins from a clean DOM (this also
    // covers clicking outside to dismiss). Interacting with the toolbar or
    // popover must NOT clear it, or the chosen action would have nothing to act
    // on. The re-wrap, if the user is selecting again, happens on mouseup.
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      const toolbar = document.querySelector(".annotationToolbar");
      const popover = document.querySelector(".commentPopover");
      if (toolbar?.contains(target) || popover?.contains(target)) return;
      clearPendingMark(container!);
      setSelectionRect(null);
      setPendingSelection(null);
    }

    container.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      container.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
    };
    // `planText` is included so this effect re-runs once the plan surface is
    // actually mounted: on first render `session` is null and the surface does
    // not exist, so `containerRef.current` is null and no listener attaches.
    // When the session loads, `planText` changes from "" to content, re-running
    // this effect with the surface now in the DOM.
  }, [containerRef, planText]);

  // ---------------------------------------------------------------------------
  // Keep the toolbar glued to the selection object while scrolling/resizing.
  // The content pane (.contentPane) is the scroll container, so we listen in the
  // capture phase to catch its scroll events even though they don't bubble.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!pendingSelection) return;
    const container = containerRef.current;
    if (!container) return;

    let raf = 0;
    const recompute = () => {
      const rect = pendingMarkRect(container);
      if (rect) {
        setSelectionRect(rect);
      } else {
        // Pending mark vanished (e.g. the plan re-rendered) — dismiss cleanly.
        setSelectionRect(null);
        setPendingSelection(null);
      }
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };

    recompute();
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", recompute);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", recompute);
    };
  }, [pendingSelection, containerRef]);

  // ---------------------------------------------------------------------------
  // Keep the comment popover glued to its annotation mark while scrolling.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!editingAnnotationId) return;
    const container = containerRef.current;
    if (!container) return;

    let raf = 0;
    const recompute = () => {
      const mark = container.querySelector(`[data-annotation-id="${editingAnnotationId}"]`);
      if (mark) setPopoverRect(mark.getBoundingClientRect());
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };

    recompute();
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", recompute);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", recompute);
    };
  }, [editingAnnotationId, containerRef]);

  // ---------------------------------------------------------------------------
  // Re-anchor highlights after every planText or annotation change.
  // ---------------------------------------------------------------------------
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    clearHighlightMarks(container);

    const newOrphans = new Set<string>();

    for (const ann of annotations) {
      const range = findTextRange(container, ann.originalText, ann.prefix, ann.suffix);
      if (!range) {
        newOrphans.add(ann.id);
        continue;
      }

      // Determine type-specific class modifier.
      let typeClass = "";
      if (ann.type === "DELETION") typeClass = " annotation-highlight--deletion";
      else if (ann.label) typeClass = " annotation-highlight--label";

      // Wrap each intersected text node separately so multi-block annotations
      // don't tear element structure apart (see wrapRangeWithMarks).
      const marks = wrapRangeWithMarks(range, () => document.createElement("mark"));
      if (marks.length === 0) {
        newOrphans.add(ann.id);
        continue;
      }
      for (const mark of marks) {
        mark.className = `annotation-highlight${typeClass}`;
        mark.dataset.annotationId = ann.id;
        mark.dataset.annotationType = ann.type;
        if (ann.label) mark.dataset.annotationLabel = ann.label;
      }
    }

    setOrphans(newOrphans);
  }, [planText, annotations, containerRef]);

  // ---------------------------------------------------------------------------
  // CRUD helpers
  // ---------------------------------------------------------------------------
  const addAnnotation = useCallback((partial: Omit<LiteAnnotation, "id">) => {
    const ann: LiteAnnotation = { id: generateId(), ...partial };
    setAnnotations((prev) => {
      const next = [...prev, ann];
      saveToStorage(sessionId, next);
      return next;
    });
    return ann.id;
  }, [sessionId]);

  const updateAnnotation = useCallback((id: string, patch: Partial<LiteAnnotation>) => {
    setAnnotations((prev) => {
      const next = prev.map((a) => (a.id === id ? { ...a, ...patch } : a));
      saveToStorage(sessionId, next);
      return next;
    });
  }, [sessionId]);

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => {
      const next = prev.filter((a) => a.id !== id);
      saveToStorage(sessionId, next);
      return next;
    });
  }, [sessionId]);

  // ---------------------------------------------------------------------------
  // Toolbar action handlers
  // ---------------------------------------------------------------------------
  function dismissToolbar() {
    setSelectionRect(null);
    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  function handleComment() {
    if (!pendingSelection) return;
    const { originalText, prefix, suffix, blockId } = pendingSelection;
    const id = addAnnotation({
      type: "COMMENT",
      originalText,
      prefix,
      suffix,
      ...(blockId !== undefined ? { blockId } : {}),
      comment: "",
    });
    setEditingAnnotationId(id);
    setPopoverRect(selectionRect);
    dismissToolbar();
  }

  function handleDelete() {
    if (!pendingSelection) return;
    const { originalText, prefix, suffix, blockId } = pendingSelection;
    addAnnotation({
      type: "DELETION",
      originalText,
      prefix,
      suffix,
      ...(blockId !== undefined ? { blockId } : {}),
    });
    dismissToolbar();
  }

  function handleLabel(label: string) {
    if (!pendingSelection) return;
    const { originalText, prefix, suffix, blockId } = pendingSelection;
    addAnnotation({
      type: "COMMENT",
      originalText,
      prefix,
      suffix,
      ...(blockId !== undefined ? { blockId } : {}),
      label,
    });
    dismissToolbar();
  }

  // ---------------------------------------------------------------------------
  // Popover handlers
  // ---------------------------------------------------------------------------
  function handlePopoverSave(annotationId: string, text: string) {
    updateAnnotation(annotationId, { comment: text });
    setEditingAnnotationId(undefined);
    setPopoverRect(null);
  }

  function handlePopoverClose() {
    setEditingAnnotationId(undefined);
    setPopoverRect(null);
  }

  // ---------------------------------------------------------------------------
  // Panel handlers
  // ---------------------------------------------------------------------------
  function handleScrollTo(annotationId: string) {
    const mark = containerRef.current?.querySelector(`[data-annotation-id="${annotationId}"]`);
    mark?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleEdit(annotationId: string) {
    const ann = annotations.find((a) => a.id === annotationId);
    if (!ann || ann.type !== "COMMENT" || ann.label) return;
    // Find the mark's rect for popover positioning.
    const mark = containerRef.current?.querySelector(`[data-annotation-id="${annotationId}"]`);
    const rect = mark?.getBoundingClientRect() ?? null;
    setEditingAnnotationId(annotationId);
    setPopoverRect(rect);
  }

  // ---------------------------------------------------------------------------
  // Derived: initial text for the popover
  // ---------------------------------------------------------------------------
  const editingAnnotation = annotations.find((a) => a.id === editingAnnotationId);

  // ---------------------------------------------------------------------------
  // Render pieces
  // ---------------------------------------------------------------------------
  const toolbar = React.createElement(AnnotationToolbar, {
    selectionRect: selectionRect && pendingSelection ? selectionRect : null,
    onComment: handleComment,
    onDelete: handleDelete,
    onLabel: handleLabel,
    labels: QUICK_LABELS,
  });

  const popover = React.createElement(CommentPopover, {
    annotationId: editingAnnotationId,
    initialText: editingAnnotation?.comment ?? "",
    onSave: handlePopoverSave,
    onClose: handlePopoverClose,
    anchorRect: popoverRect,
  });

  const panel = annotations.length > 0
    ? React.createElement(AnnotationPanel, {
        annotations,
        onScrollTo: handleScrollTo,
        onEdit: handleEdit,
        onDelete: deleteAnnotation,
        orphans,
      })
    : null;

  return { annotations, toolbar, popover, panel };
}
