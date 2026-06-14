/**
 * InlineMarkdown — converts inline markdown syntax to real React elements.
 *
 * Supported spans (in order of precedence):
 *   **text** / __text__  → <strong>
 *   *text*  / _text_     → <em>
 *   `code`               → <code>
 *   ~~text~~             → <s>
 *   [text](url)          → <a>
 *
 * Returns a fragment of React nodes. Never uses dangerouslySetInnerHTML.
 */

import React from "react";

interface Props {
  text: string;
}

// Ordered inline token patterns. Each entry: [regex, renderer].
// The regex must have exactly one group capturing the inner content,
// except for links which have two groups.
const TOKENS: Array<{
  re: RegExp;
  render: (match: RegExpExecArray, key: number) => React.ReactNode;
}> = [
  {
    // **bold** (asterisks may open/close intraword, per CommonMark)
    re: /\*\*(.+?)\*\*/,
    render: (m, key) => <strong key={key}>{m[1]}</strong>,
  },
  {
    // __bold__ (underscores only at word boundaries, so foo__bar__ stays literal)
    re: /(?<!\w)__(.+?)__(?!\w)/,
    render: (m, key) => <strong key={key}>{m[1]}</strong>,
  },
  {
    // *italic* (asterisks may open/close intraword)
    re: /\*(.+?)\*/,
    render: (m, key) => <em key={key}>{m[1]}</em>,
  },
  {
    // _italic_ (underscores only at word boundaries, so some_var_name stays literal)
    re: /(?<!\w)_(.+?)_(?!\w)/,
    render: (m, key) => <em key={key}>{m[1]}</em>,
  },
  {
    // `inline code`
    re: /`([^`]+)`/,
    render: (m, key) => <code key={key}>{m[1]}</code>,
  },
  {
    // ~~strikethrough~~
    re: /~~(.+?)~~/,
    render: (m, key) => <s key={key}>{m[1]}</s>,
  },
  {
    // [text](url)
    re: /\[([^\]]+)\]\(([^)]+)\)/,
    render: (m, key) => (
      <a key={key} href={m[2]} target="_blank" rel="noreferrer">
        {m[1]}
      </a>
    ),
  },
];

function parseInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let keyCounter = 0;

  while (remaining.length > 0) {
    // Find the earliest match across all token patterns.
    let earliest: { index: number; match: RegExpExecArray; tokenIndex: number } | null = null;

    for (let ti = 0; ti < TOKENS.length; ti++) {
      const token = TOKENS[ti];
      if (!token) continue;
      const re = new RegExp(token.re.source); // fresh exec context
      const m = re.exec(remaining);
      if (m === null) continue;
      if (earliest === null || m.index < earliest.index) {
        earliest = { index: m.index, match: m, tokenIndex: ti };
      }
    }

    if (earliest === null) {
      // No more tokens — emit the rest as plain text.
      nodes.push(remaining);
      break;
    }

    // Text before the match.
    if (earliest.index > 0) {
      nodes.push(remaining.slice(0, earliest.index));
    }

    // Emit the matched token.
    const token = TOKENS[earliest.tokenIndex];
    if (token) {
      nodes.push(token.render(earliest.match, keyCounter++));
    }

    remaining = remaining.slice(earliest.index + earliest.match[0].length);
  }

  return nodes;
}

export function InlineMarkdown({ text }: Props): React.ReactElement {
  const nodes = parseInline(text);
  return <>{nodes}</>;
}
