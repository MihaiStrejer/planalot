/**
 * BlockRenderer — dispatches a MarkdownBlock to its registered component.
 *
 * Every rendered element carries:
 *   data-block-id   — stable anchor for LeftRail click-to-scroll and
 *                     annotation text-quote re-anchoring.
 *   data-block-type — lets CSS / tools target specific block kinds.
 *
 * BlockRenderer itself is never edited when adding block types or languages.
 * Register new renderers via registerBlock() / registerCode() in registry.ts.
 */

import React from "react";
import type { MarkdownBlock } from "@planalot/shared";
import { blockRegistry } from "./registry";

interface Props {
  block: MarkdownBlock;
}

export function BlockRenderer({ block }: Props): React.ReactElement {
  const Component = blockRegistry[block.type] ?? blockRegistry.paragraph;

  return (
    <div
      data-block-id={block.id}
      data-block-type={block.type}
      className="blockWrapper"
    >
      <Component block={block} />
    </div>
  );
}
