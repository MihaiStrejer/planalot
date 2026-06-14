/**
 * Table — renders a GFM table block.
 *
 * `block.content` holds the RAW table text (header line, delimiter line, then
 * body lines, joined with "\n"). Cells are split via the shared splitTableCells
 * helper and rendered through InlineMarkdown so `code`, **bold**, etc. work
 * inside cells.
 *
 * Total by design: never throws on malformed input. With no delimiter/body it
 * renders whatever rows are present.
 *
 * No CSS is imported here — table styling lives in styles.css keyed off the
 * wrapper `[data-block-type="table"]`, which also keeps this file runnable under
 * node:test.
 */

import React from "react";
import { splitTableCells } from "@planalot/shared";
import type { BlockProps } from "../registry";
import { InlineMarkdown } from "../InlineMarkdown";

type Align = "left" | "right" | "center";

// Column alignment from a delimiter cell: :--: center, --: right, :-- left.
function alignFor(cell: string): Align | undefined {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

function cellStyle(align: Align | undefined): React.CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}

export function Table({ block }: BlockProps): React.ReactElement {
  const rows = block.content.split("\n").filter((line) => line.trim() !== "");
  const header = rows[0];
  const delimiter = rows[1];

  const headerCells = header !== undefined ? splitTableCells(header) : [];
  const aligns = delimiter !== undefined ? splitTableCells(delimiter).map(alignFor) : [];
  const bodyRows = rows.slice(2).map((row) => splitTableCells(row));

  return (
    <table>
      <thead>
        <tr>
          {headerCells.map((cell, c) => (
            <th key={c} style={cellStyle(aligns[c])}>
              <InlineMarkdown text={cell} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {bodyRows.map((cells, r) => (
          <tr key={r}>
            {cells.map((cell, c) => (
              <td key={c} style={cellStyle(aligns[c])}>
                <InlineMarkdown text={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
