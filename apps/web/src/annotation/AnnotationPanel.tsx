/**
 * AnnotationPanel — list of annotation cards rendered in the right rail.
 *
 * FIXED PROP INTERFACE (do not change — T4 fills the implementation):
 *
 *   interface AnnotationPanelProps {
 *     annotations: LiteAnnotation[];
 *     onScrollTo: (annotationId: string) => void;
 *     onEdit: (annotationId: string) => void;
 *     onDelete: (annotationId: string) => void;
 *   }
 *
 * T4 adds optional `orphans` (set of IDs whose anchor text is gone).
 *
 * T4 implements per-type cards (comment / deletion / label-chip),
 * orphan badge, click-to-scroll, edit, and delete affordances.
 */

import React from "react";
import type { LiteAnnotation } from "@planalot/shared";

export interface AnnotationPanelProps {
  annotations: LiteAnnotation[];
  onScrollTo: (annotationId: string) => void;
  onEdit: (annotationId: string) => void;
  onDelete: (annotationId: string) => void;
  /** IDs of annotations whose anchor text is no longer found in the plan. */
  orphans?: Set<string>;
}

export function AnnotationPanel({
  annotations,
  onScrollTo,
  onEdit,
  onDelete,
  orphans,
}: AnnotationPanelProps): React.ReactElement | null {
  if (annotations.length === 0) return null;

  return (
    <div className="annotationPanel">
      <h3 className="annotationPanel__heading">Annotations</h3>
      <ul className="annotationPanel__list">
        {annotations.map((ann) => (
          <AnnotationCard
            key={ann.id}
            annotation={ann}
            isOrphan={orphans?.has(ann.id) ?? false}
            onScrollTo={onScrollTo}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CardProps {
  annotation: LiteAnnotation;
  isOrphan: boolean;
  onScrollTo: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

function AnnotationCard({ annotation, isOrphan, onScrollTo, onEdit, onDelete }: CardProps) {
  const { id, type, originalText, comment, label } = annotation;

  const cardClass = [
    "annotationCard",
    type === "DELETION" ? "annotationCard--deletion" : "",
    label ? "annotationCard--label" : "",
    isOrphan ? "annotationCard--orphan" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Whether this annotation supports free-text editing (COMMENT with no label).
  const canEdit = type === "COMMENT" && !label;

  return (
    <li className={cardClass}>
      {/* Orphan badge */}
      {isOrphan && (
        <span className="annotationCard__orphanBadge" title="Anchor text no longer found in plan">
          orphaned
        </span>
      )}

      {/* Quoted text — click to scroll to mark */}
      <button
        type="button"
        className="annotationCard__quote"
        onClick={() => onScrollTo(id)}
        title="Scroll to highlight"
      >
        &ldquo;{originalText.length > 80 ? originalText.slice(0, 80) + "…" : originalText}&rdquo;
      </button>

      {/* Type-specific body */}
      {type === "DELETION" && (
        <span className="annotationCard__tag annotationCard__tag--deletion">DELETE</span>
      )}
      {type === "COMMENT" && label && (
        <span className={`annotationCard__chip annotationCard__chip--${label}`}>{label}</span>
      )}
      {type === "COMMENT" && !label && comment && (
        <p className="annotationCard__comment">{comment}</p>
      )}
      {type === "COMMENT" && !label && !comment && (
        <p className="annotationCard__comment annotationCard__comment--empty">(no comment)</p>
      )}

      {/* Actions */}
      <div className="annotationCard__actions">
        {canEdit && (
          <button type="button" className="annotationCard__btn" onClick={() => onEdit(id)}>
            Edit
          </button>
        )}
        <button
          type="button"
          className="annotationCard__btn annotationCard__btn--delete"
          onClick={() => onDelete(id)}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
