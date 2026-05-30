/**
 * Registry: block-type dispatch and code-language dispatch.
 *
 * ─────────────────────────────────────────────────────────────────
 * EXTENDING THE REGISTRY
 *
 * To add a new block renderer:
 *   import { registerBlock } from "./registry";
 *   registerBlock("my-type", MyComponent);
 *
 * To add a language-specific code renderer (e.g. mermaid — T2):
 *   import { registerCode } from "./registry";
 *   registerCode("mermaid", MermaidBlock);
 *
 * To replace the default syntax highlighter (T2):
 *   registerCode("default", HighlightedCode);
 *
 * BlockRenderer reads from these maps; it never needs to be edited.
 * ─────────────────────────────────────────────────────────────────
 */

import React from "react";
import type { MarkdownBlock } from "@planalot/shared";

// ---------------------------------------------------------------------------
// Prop shapes — exported so downstream components can type themselves.
// ---------------------------------------------------------------------------

/** Props passed to every block renderer component. */
export interface BlockProps {
  block: MarkdownBlock;
}

/**
 * Props passed to code-language renderer components.
 * `language` is the info string from the fence (e.g. "python", "mermaid"),
 * or undefined for bare fences. `content` is the raw fence body.
 */
export interface CodeProps {
  block: MarkdownBlock;
  language: string | undefined;
  content: string;
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/** Maps block.type → React component. Keyed by MarkdownBlock["type"]. */
export const blockRegistry: Record<MarkdownBlock["type"], React.FC<BlockProps>> = {
  heading: () => null,
  paragraph: () => null,
  "list-item": () => null,
  code: () => null,
  hr: () => null,
  blockquote: () => null,
};

/**
 * Maps language string → React component.
 * "default" is the fallback used when block.language is undefined or not
 * found in the map. T2 replaces "default" with HighlightedCode and adds
 * "mermaid" → MermaidBlock.
 */
export const codeRegistry: Record<string, React.FC<CodeProps>> = {};

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

export function registerBlock(type: MarkdownBlock["type"], fc: React.FC<BlockProps>): void {
  blockRegistry[type] = fc;
}

export function registerCode(language: string, fc: React.FC<CodeProps>): void {
  codeRegistry[language] = fc;
}
