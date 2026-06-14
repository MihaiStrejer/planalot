// Parser unit tests for parseMarkdownBlocks — pure string -> blocks, no DOM.
// Covers GFM table parsing (the regression that motivated this work) and the
// list-item lazy-continuation behavior.

import test from "node:test";
import assert from "node:assert/strict";

import { parseMarkdownBlocks, splitTableCells, type MarkdownBlock } from "../src/index.ts";

const typesOf = (blocks: MarkdownBlock[]): string[] => blocks.map((b) => b.type);
const only = (blocks: MarkdownBlock[], type: MarkdownBlock["type"]): MarkdownBlock[] =>
  blocks.filter((b) => b.type === type);

// ── GFM tables ───────────────────────────────────────────────────────────────

test("regression fixture: heading + table + list parse as distinct blocks", () => {
  const md = [
    "## Scenarios",
    "",
    "| Scenario | Interpretation |",
    "| --- | --- |",
    "| Entry condition never triggered | falls back to `HOLD` |",
    "| Exit fired twice | dedupe on `orderId` |",
    "",
    "- first bullet",
    "- second bullet",
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);

  // Exactly one table block, holding the raw header+delimiter+body rows.
  const tables = only(blocks, "table");
  assert.equal(tables.length, 1, "the table must collapse into ONE table block");
  const table = tables[0]!;
  assert.match(table.content, /^\| Scenario \| Interpretation \|/);
  assert.equal(table.content.split("\n").length, 4, "header + delimiter + 2 body rows");
  assert.ok(table.content.includes("`HOLD`"), "raw backticked cell text is preserved");

  // The bullets remain separate list-item blocks (not folded into the table).
  const items = only(blocks, "list-item");
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((b) => b.content), ["first bullet", "second bullet"]);

  // Heading survives, and nothing became a flattened paragraph.
  assert.equal(only(blocks, "heading").length, 1);
  assert.equal(only(blocks, "paragraph").length, 0, "no part of the table leaks into a paragraph");
});

test("tables parse with and without outer pipes", () => {
  const withPipes = parseMarkdownBlocks("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.deepEqual(typesOf(withPipes), ["table"]);

  const withoutPipes = parseMarkdownBlocks("a | b\n--- | ---\n1 | 2");
  assert.deepEqual(typesOf(withoutPipes), ["table"]);
});

test("alignment delimiters (:--, --:, :--:) are accepted", () => {
  const md = "| L | R | C |\n| :-- | --: | :--: |\n| 1 | 2 | 3 |";
  const blocks = parseMarkdownBlocks(md);
  assert.deepEqual(typesOf(blocks), ["table"]);
  // Sanity-check the shared cell splitter on the delimiter row.
  assert.deepEqual(splitTableCells("| :-- | --: | :--: |"), [":--", "--:", ":--:"]);
});

test("negative: a lone pipe line with no delimiter row stays a paragraph", () => {
  const blocks = parseMarkdownBlocks("| just text |");
  assert.deepEqual(typesOf(blocks), ["paragraph"]);
});

test("negative: header/delimiter column-count mismatch is not a table", () => {
  const blocks = parseMarkdownBlocks("| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |");
  assert.ok(!typesOf(blocks).includes("table"), "mismatched columns must not parse as a table");
});

// ── List-item lazy continuations (fix #4) ────────────────────────────────────

test("wrapped list item folds continuation lines into one item", () => {
  const md = "- This is a long\n  item that wraps\n  across three lines";
  const blocks = parseMarkdownBlocks(md);
  const items = only(blocks, "list-item");
  assert.equal(items.length, 1, "wrapped lines join into a single list item");
  assert.equal(items[0]!.content, "This is a long item that wraps across three lines");
});

test("consecutive list items stay separate", () => {
  const blocks = parseMarkdownBlocks("- a\n- b");
  const items = only(blocks, "list-item");
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((b) => b.content), ["a", "b"]);
});

test("a following block (heading) is not absorbed as a continuation", () => {
  const blocks = parseMarkdownBlocks("- item\n## Heading");
  assert.deepEqual(typesOf(blocks), ["list-item", "heading"]);
});

test("a following table is not absorbed as a continuation", () => {
  const blocks = parseMarkdownBlocks("- item\n| a | b |\n| --- | --- |");
  assert.deepEqual(typesOf(blocks), ["list-item", "table"]);
});
