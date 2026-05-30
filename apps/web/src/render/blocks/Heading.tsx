import React from "react";
import type { BlockProps } from "../registry";
import { InlineMarkdown } from "../InlineMarkdown";

export function Heading({ block }: BlockProps): React.ReactElement {
  const depth = Math.min(Math.max(block.level ?? 1, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
  const Tag = `h${depth}` as const;
  return <Tag><InlineMarkdown text={block.content} /></Tag>;
}
