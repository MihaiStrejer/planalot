/**
 * CommentPopover — textarea popover for attaching free-text to a COMMENT annotation.
 *
 * FIXED PROP INTERFACE (do not change — T4 fills the implementation):
 *
 *   interface CommentPopoverProps {
 *     // The annotation being commented on (undefined = popover closed).
 *     annotationId: string | undefined;
 *     initialText: string;
 *     onSave: (annotationId: string, text: string) => void;
 *     onClose: () => void;
 *     // Anchor position for popover placement.
 *     anchorRect: DOMRect | null;
 *   }
 *
 * T4 implements the textarea, save/cancel actions, and popover positioning.
 */

import React, { useEffect, useRef, useState } from "react";

export interface CommentPopoverProps {
  annotationId: string | undefined;
  initialText: string;
  onSave: (annotationId: string, text: string) => void;
  onClose: () => void;
  anchorRect: DOMRect | null;
}

export function CommentPopover({
  annotationId,
  initialText,
  onSave,
  onClose,
  anchorRect,
}: CommentPopoverProps): React.ReactElement | null {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync local text when the target annotation changes.
  useEffect(() => {
    setText(initialText);
  }, [annotationId, initialText]);

  // Auto-focus on open.
  useEffect(() => {
    if (annotationId) {
      textareaRef.current?.focus();
    }
  }, [annotationId]);

  if (!annotationId) return null;

  // Position below the anchor rect; fall back to a sensible default.
  const style: React.CSSProperties = anchorRect
    ? {
        position: "fixed",
        top: anchorRect.bottom + 8,
        left: anchorRect.left,
        zIndex: 1001,
      }
    : {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 1001,
      };

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      onClose();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      onSave(annotationId!, text);
    }
  }

  return (
    <div className="commentPopover" style={style} role="dialog" aria-label="Add comment">
      <textarea
        ref={textareaRef}
        className="commentPopover__textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment… (Ctrl+Enter to save, Esc to cancel)"
        rows={4}
      />
      <div className="commentPopover__actions">
        <button
          type="button"
          className="commentPopover__btn commentPopover__btn--save"
          onClick={() => onSave(annotationId, text)}
        >
          Save
        </button>
        <button
          type="button"
          className="commentPopover__btn commentPopover__btn--cancel"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
