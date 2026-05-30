import React from "react";
import type { BlockProps } from "../registry";
import { InlineMarkdown } from "../InlineMarkdown";

export function Paragraph({ block }: BlockProps): React.ReactElement {
  return <p><InlineMarkdown text={block.content} /></p>;
}
