/**
 * AnnotationToolbar — floating toolbar that appears over a text selection.
 *
 * FIXED PROP INTERFACE (do not change — T4 fills the implementation):
 *
 *   interface AnnotationToolbarProps {
 *     // Bounding rect of the current selection, for positioning.
 *     selectionRect: DOMRect | null;
 *     onComment: () => void;
 *     onDelete: () => void;
 *     onLabel: (label: string) => void;
 *     labels: string[];
 *   }
 *
 * T4 implements the three affordances (Comment, Delete, Quick-label menu)
 * and positions the toolbar at selectionRect.
 */

import React, { useState } from "react";

export interface AnnotationToolbarProps {
  selectionRect: DOMRect | null;
  onComment: () => void;
  onDelete: () => void;
  onLabel: (label: string) => void;
  labels: string[];
}

export function AnnotationToolbar({
  selectionRect,
  onComment,
  onDelete,
  onLabel,
  labels,
}: AnnotationToolbarProps): React.ReactElement | null {
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);

  if (!selectionRect) return null;

  // Position the toolbar centered above the selection rectangle.
  // Fixed positioning maps DOMRect values (viewport-relative) 1:1 without scroll offset.
  const style: React.CSSProperties = {
    position: "fixed",
    top: selectionRect.top - 44,
    left: selectionRect.left + selectionRect.width / 2,
    transform: "translateX(-50%)",
    zIndex: 1000,
  };

  return (
    <div className="annotationToolbar" style={style} onMouseDown={(e) => e.preventDefault()}>
      <button
        type="button"
        className="annotationToolbar__btn"
        onClick={onComment}
        title="Add comment"
      >
        Comment
      </button>
      <button
        type="button"
        className="annotationToolbar__btn annotationToolbar__btn--delete"
        onClick={onDelete}
        title="Mark for deletion"
      >
        Delete
      </button>
      <div className="annotationToolbar__labelMenu">
        <button
          type="button"
          className="annotationToolbar__btn annotationToolbar__btn--label"
          onClick={() => setLabelMenuOpen((v) => !v)}
          title="Quick label"
        >
          Label ▾
        </button>
        {labelMenuOpen && (
          <ul className="annotationToolbar__labelDropdown">
            {labels.map((lbl) => (
              <li key={lbl}>
                <button
                  type="button"
                  className={`annotationToolbar__labelItem annotationToolbar__labelItem--${lbl}`}
                  onClick={() => {
                    setLabelMenuOpen(false);
                    onLabel(lbl);
                  }}
                >
                  {lbl}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
