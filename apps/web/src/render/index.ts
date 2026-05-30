/**
 * Render pipeline entry point.
 *
 * Importing this module populates blockRegistry and codeRegistry with all
 * default renderers.
 */

export { BlockRenderer } from "./BlockRenderer";
export { InlineMarkdown } from "./InlineMarkdown";
export {
  blockRegistry,
  codeRegistry,
  registerBlock,
  registerCode,
  type BlockProps,
  type CodeProps,
} from "./registry";

import { registerBlock, registerCode } from "./registry";
import { Heading } from "./blocks/Heading";
import { Paragraph } from "./blocks/Paragraph";
import { ListItem } from "./blocks/ListItem";
import { Blockquote } from "./blocks/Blockquote";
import { Hr } from "./blocks/Hr";
import { CodeBlock } from "./blocks/CodeBlock";
import { HighlightedCode } from "./blocks/HighlightedCode";
import { MermaidBlock } from "./blocks/MermaidBlock";

// Register all default block renderers.
registerBlock("heading", Heading);
registerBlock("paragraph", Paragraph);
registerBlock("list-item", ListItem);
registerBlock("blockquote", Blockquote);
registerBlock("hr", Hr);
registerBlock("code", CodeBlock);

// Register code-language renderers.
// "default" handles all languages (highlight.js with auto-detect fallback).
// "mermaid" renders the fence body as an SVG diagram.
registerCode("default", HighlightedCode);
registerCode("mermaid", MermaidBlock);
