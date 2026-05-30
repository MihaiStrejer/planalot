/**
 * RenderErrorContext — lets block renderers report a failure to render up to
 * the app shell, so the user can one-click "Report to agent" and the owning
 * harness gets asked to fix the plan.
 *
 * Render errors are transient UI state: the app resets the collection on every
 * plan edit and blocks re-report on the next render, so the set always reflects
 * the current plan. Keyed by block id.
 */

import React, { useContext } from "react";

export interface RenderError {
  /** Stable-per-render block id (data-block-id) of the failing block. */
  blockId: string;
  /** What kind of block failed — e.g. "mermaid". Drives the report wording. */
  kind: string;
  /** Human-facing error message from the renderer (e.g. mermaid parse error). */
  message: string;
  /** The raw block source, included in the report so the agent can fix it. */
  source: string;
}

export interface RenderErrorContextValue {
  report: (error: RenderError) => void;
  clear: (blockId: string) => void;
}

export const RenderErrorContext = React.createContext<RenderErrorContextValue | null>(null);

/** Renderers call this to report/clear their render status. No-op outside a provider. */
export function useReportRenderError(): RenderErrorContextValue {
  return useContext(RenderErrorContext) ?? noop;
}

const noop: RenderErrorContextValue = { report: () => {}, clear: () => {} };
