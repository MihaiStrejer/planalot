import React from "react";
import type { BlockProps } from "../registry";
import { InlineMarkdown } from "../InlineMarkdown";

export function Blockquote({ block }: BlockProps): React.ReactElement {
  // Multi-line blockquotes: each line becomes a <p> inside <blockquote>.
  const lines = block.content.split("\n");
  return (
    <blockquote className="planBlockquote">
      {lines.map((line, i) =>
        line.trim() === "" ? (
          <br key={i} />
        ) : (
          <p key={i}><InlineMarkdown text={line} /></p>
        )
      )}
    </blockquote>
  );
}
