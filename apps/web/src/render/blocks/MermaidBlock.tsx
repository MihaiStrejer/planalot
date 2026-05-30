/**
 * MermaidBlock — renders a ```mermaid fence as an inline SVG diagram.
 *
 * - mermaid.initialize() runs once with suppressErrorRendering + logLevel:"fatal"
 *   so a syntax error neither injects mermaid's own error graphic into the DOM
 *   nor logs to the console.
 * - We validate with mermaid.parse() (which throws on invalid, giving us the
 *   error message) before rendering. On failure we show the raw fenced source
 *   AND report the error up via RenderErrorContext so the user can one-click
 *   "Report to agent". On success we clear any prior report for this block.
 */

import React, { useEffect, useId, useState } from "react";
import mermaid from "mermaid";
import type { CodeProps } from "../registry";
import { useReportRenderError } from "../RenderErrorContext";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  suppressErrorRendering: true,
  logLevel: "fatal",
});

export const MermaidBlock: React.FC<CodeProps> = ({ block, content }) => {
  const { report, clear } = useReportRenderError();
  const uid = useId();
  const renderId = `mermaid-${uid.replace(/[^a-zA-Z0-9-]/g, "")}`;

  const [svg, setSvg] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<string | null>(null);

  useEffect(() => {
    setSvg(null);
    setErrorSource(null);
    let cancelled = false;

    const run = async () => {
      try {
        // parse() throws on invalid syntax; logLevel:"fatal" keeps the console clean.
        await mermaid.parse(content);
        const result = await mermaid.render(renderId, content);
        if (cancelled) return;
        setSvg(result.svg);
        clear(block.id);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setErrorSource(content);
        report({ blockId: block.id, kind: "mermaid", message, source: content });
      }
    };
    void run();

    return () => {
      cancelled = true;
      // mermaid may leave temporary nodes named `renderId` or `d{renderId}`.
      for (const elId of [renderId, `d${renderId}`]) {
        document.getElementById(elId)?.remove();
      }
    };
  }, [content, block.id, renderId, report, clear]);

  if (svg === null && errorSource === null) {
    return (
      <div className="mermaid-pending" aria-label="Rendering diagram…">
        <pre className="mermaid-fallback"><code>{content}</code></pre>
      </div>
    );
  }

  if (errorSource !== null) {
    return (
      <div className="mermaid-error">
        <span className="mermaid-error-label">Mermaid parse error — showing source</span>
        <pre className="mermaid-fallback"><code>{errorSource}</code></pre>
      </div>
    );
  }

  return <div className="mermaid-container" dangerouslySetInnerHTML={{ __html: svg as string }} />;
};
