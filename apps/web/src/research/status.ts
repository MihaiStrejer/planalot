/**
 * Shared presentation metadata for research inquiries — used by both the left
 * rail (compact glyphs) and the main research view (cards), so status colors
 * and labels stay in one place.
 */

import type { InquiryStatus, ResearchSession } from "@planalot/shared";

export interface InquiryMeta {
  label: string;
  /** CSS color expression keyed to the active theme. */
  colorVar: string;
  glyph: string;
}

export const INQUIRY_META: Record<InquiryStatus, InquiryMeta> = {
  active: { label: "active", colorVar: "var(--accent)", glyph: "◐" },
  open: { label: "open", colorVar: "var(--text-subtle)", glyph: "○" },
  blocked: { label: "blocked", colorVar: "var(--danger)", glyph: "⊘" },
  resolved: { label: "resolved", colorVar: "var(--success)", glyph: "●" },
  dropped: { label: "dropped", colorVar: "var(--text-subtle)", glyph: "⊝" },
};

export interface ResearchProgress {
  resolved: number;
  total: number;
}

/** Resolved vs. live total. `dropped` inquiries are excluded from the denominator. */
export function researchProgress(session: ResearchSession): ResearchProgress {
  const live = session.inquiries.filter((inquiry) => inquiry.status !== "dropped");
  const resolved = live.filter((inquiry) => inquiry.status === "resolved").length;
  return { resolved, total: live.length };
}
