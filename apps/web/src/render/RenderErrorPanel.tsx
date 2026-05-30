/**
 * RenderErrorPanel — lists blocks that failed to render and offers a one-click
 * "Report to agent" that sends the failure (block kind + error + source) to the
 * active harness via the normal feedback channel. User-gated; never auto-sends.
 */

import React from "react";
import type { RenderError } from "./RenderErrorContext";

export function RenderErrorPanel({
  errors,
  reported,
  onReport,
}: {
  errors: RenderError[];
  reported: Set<string>;
  onReport: (error: RenderError) => void;
}): React.ReactElement {
  return (
    <div className="renderErrorPanel">
      <strong>Render errors</strong>
      {errors.map((err) => {
        const isReported = reported.has(err.blockId);
        return (
          <div key={err.blockId} className="renderErrorCard">
            <div className="renderErrorCard__head">
              <span className="renderErrorCard__kind">{err.kind}</span>
              <span className="renderErrorCard__msg">{err.message}</span>
            </div>
            <button
              type="button"
              className="ghost inline"
              disabled={isReported}
              onClick={() => onReport(err)}
            >
              {isReported ? "Reported ✓" : "Report to agent"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
