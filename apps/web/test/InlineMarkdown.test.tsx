// Inline-span tests — server-rendered, no jsdom. Primarily guards fix #3
// (intraword underscores must not italicize) without regressing real emphasis.

import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineMarkdown } from "../src/render/InlineMarkdown";

const html = (text: string): string => renderToStaticMarkup(<InlineMarkdown text={text} />);

test("intraword underscores are NOT italicized (fix #3)", () => {
  const out = html("call some_var_name here");
  assert.ok(!out.includes("<em>"), `no emphasis expected, got: ${out}`);
  assert.ok(out.includes("some_var_name"), "identifier text is preserved verbatim");
});

test("real _italic_ and *italic* still render <em>", () => {
  assert.ok(html("an _italic_ word").includes("<em>italic</em>"));
  assert.ok(html("an *italic* word").includes("<em>italic</em>"));
});

test("**bold** and __bold__ still render <strong>", () => {
  assert.ok(html("a **bold** word").includes("<strong>bold</strong>"));
  assert.ok(html("a __bold__ word").includes("<strong>bold</strong>"));
});

test("inline `code` still renders <code>", () => {
  assert.ok(html("use `npm test` now").includes("<code>npm test</code>"));
});
