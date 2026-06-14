// Renderer test for the Table block — server-rendered via renderToStaticMarkup,
// no jsdom required. Validates that a parsed GFM table becomes a real <table>
// with header cells, inline markdown inside cells, and per-column alignment.

import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarkdownBlock } from "@planalot/shared";
import { Table } from "../src/render/blocks/Table";

const tableBlock = (content: string): MarkdownBlock => ({
  id: "block-0",
  type: "table",
  content,
  startLine: 1,
});

test("renders a <table> with header text and inline <code> in a body cell", () => {
  const html = renderToStaticMarkup(
    <Table
      block={tableBlock(
        "| Scenario | Interpretation |\n| --- | --- |\n| never triggered | falls back to `HOLD` |",
      )}
    />,
  );
  assert.ok(html.includes("<table>"), "renders a table element");
  assert.match(html, /<th[^>]*>Scenario<\/th>/, "header cell carries the header text");
  assert.ok(html.includes("<td"), "renders body cells");
  assert.ok(html.includes("<code>HOLD</code>"), "backticked cell content renders as <code>");
});

test("applies per-column alignment from the delimiter row", () => {
  const html = renderToStaticMarkup(
    <Table block={tableBlock("| L | R |\n| :-- | --: |\n| 1 | 2 |")} />,
  );
  assert.match(html, /text-align:\s*left/, "left-aligned column");
  assert.match(html, /text-align:\s*right/, "right-aligned column");
});

test("is total: malformed input does not throw", () => {
  assert.doesNotThrow(() => renderToStaticMarkup(<Table block={tableBlock("| a | b |")} />));
  assert.doesNotThrow(() => renderToStaticMarkup(<Table block={tableBlock("")} />));
});
