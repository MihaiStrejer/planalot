/**
 * HighlightedCode — syntax-highlighted fenced code block renderer.
 *
 * Uses highlight.js for synchronous, language-aware highlighting.
 * When the given language is registered in hljs, uses targeted highlight();
 * otherwise falls back to highlightAuto(). Any hljs error is caught and
 * the content is rendered as plain escaped text — never throws to React.
 */

import React from "react";
import hljs from "highlight.js";
import type { CodeProps } from "../registry";

export const HighlightedCode: React.FC<CodeProps> = ({ language, content }) => {
  let highlightedHtml: string;

  try {
    if (language !== undefined && hljs.getLanguage(language) !== undefined) {
      highlightedHtml = hljs.highlight(content, { language }).value;
    } else {
      highlightedHtml = hljs.highlightAuto(content).value;
    }
  } catch {
    // Escape HTML entities so raw content renders safely.
    highlightedHtml = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  return (
    <pre className="hljs-pre" data-language={language}>
      <code
        className={`hljs${language !== undefined ? ` language-${language}` : ""}`}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    </pre>
  );
};
