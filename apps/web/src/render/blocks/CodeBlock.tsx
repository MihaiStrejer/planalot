/**
 * CodeBlock — dispatches fenced code to the appropriate language renderer.
 *
 * Lookup order:
 *   1. codeRegistry[block.language]  — e.g. "mermaid", "python", "ts"
 *   2. codeRegistry["default"]       — the default renderer (plain <pre><code>
 *                                       for T1; T2 replaces with HighlightedCode)
 *
 * T2 adds language renderers by calling:
 *   registerCode("mermaid", MermaidBlock);
 *   registerCode("default", HighlightedCode);  // replaces the T1 plain default
 *
 * This component itself never needs to be edited to add new languages.
 */

import React from "react";
import type { BlockProps } from "../registry";
import { codeRegistry } from "../registry";
import "./code.css";

export function CodeBlock({ block }: BlockProps): React.ReactElement {
  const lang = block.language;
  const Renderer = (lang !== undefined ? codeRegistry[lang] : undefined) ?? codeRegistry["default"];

  if (Renderer !== undefined) {
    return <Renderer block={block} language={lang} content={block.content} />;
  }

  // Fallback: plain <pre><code> with no highlighting.
  // Reached only if codeRegistry["default"] is somehow missing.
  return (
    <pre data-language={lang}>
      <code>{block.content}</code>
    </pre>
  );
}
