import React from "react";
import type { BlockProps } from "../registry";
import { InlineMarkdown } from "../InlineMarkdown";

export function ListItem({ block }: BlockProps): React.ReactElement {
  const level = block.level ?? 0;
  const indent = level * 20; // px per nesting level

  let marker: React.ReactNode;
  if (block.checked === true) {
    marker = <input type="checkbox" checked readOnly aria-hidden />;
  } else if (block.checked === false) {
    marker = <input type="checkbox" readOnly aria-hidden />;
  } else if (block.ordered === true) {
    marker = <span className="listMarker listMarker--ordered" />;
  } else {
    marker = <span className="listMarker listMarker--bullet">•</span>;
  }

  return (
    <p
      className="listItem"
      style={{ paddingLeft: `${14 + indent}px` }}
      data-list-level={level}
      data-ordered={block.ordered ? "true" : undefined}
      data-checked={block.checked !== undefined ? String(block.checked) : undefined}
    >
      {marker}
      <span className="listContent"><InlineMarkdown text={block.content} /></span>
    </p>
  );
}
