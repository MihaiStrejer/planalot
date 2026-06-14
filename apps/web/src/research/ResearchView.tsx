/**
 * ResearchView — main-pane projection of one research session: the markdown
 * `scope` (rendered through the shared block pipeline) plus inquiry cards with
 * live status, optional detail, and an expandable resolved `result`.
 */

import React, { useMemo, useState } from "react";
import { parseMarkdownBlocks, type ResearchInquiry, type ResearchSession } from "@planalot/shared";
import { BlockRenderer } from "../render/BlockRenderer";
import { INQUIRY_META, researchProgress } from "./status";
import "./research.css";

export function ResearchView({ session }: { session: ResearchSession }): React.ReactElement {
  const scopeBlocks = useMemo(
    () => parseMarkdownBlocks(session.scope.trim() ? session.scope : "_No scope described yet._"),
    [session.scope],
  );
  const { resolved, total } = researchProgress(session);
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 0;

  return (
    <div className="researchView">
      <header className="researchView__header">
        <div className="researchView__titleRow">
          <h1 className="researchView__title">{session.title}</h1>
          <span className={`researchBadge researchBadge--${session.status}`}>{session.status}</span>
        </div>
        <div className="researchView__progress">
          <span className="researchView__count">{resolved}/{total} resolved</span>
          <div className="researchBar" role="progressbar" aria-valuenow={resolved} aria-valuemin={0} aria-valuemax={total}>
            <div className="researchBar__fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      <section className="researchScope" aria-label="Scope">
        {scopeBlocks.map((block) => <BlockRenderer key={block.id} block={block} />)}
      </section>

      <section className="researchInquiries" aria-label="Inquiries">
        <h2 className="researchInquiries__heading">Inquiries · {session.inquiries.length}</h2>
        {session.inquiries.length === 0 ? (
          <p className="researchEmpty">No inquiries yet.</p>
        ) : (
          session.inquiries.map((inquiry) => <InquiryCard key={inquiry.id} inquiry={inquiry} />)
        )}
      </section>
    </div>
  );
}

function InquiryCard({ inquiry }: { inquiry: ResearchInquiry }): React.ReactElement {
  const meta = INQUIRY_META[inquiry.status];
  const resultBlocks = useMemo(
    () => (inquiry.result && inquiry.result.trim() ? parseMarkdownBlocks(inquiry.result) : []),
    [inquiry.result],
  );
  const hasResult = resultBlocks.length > 0;
  const [open, setOpen] = useState(false);

  return (
    <div className={`inquiryCard inquiryCard--${inquiry.status}`}>
      <button
        type="button"
        className="inquiryCard__head"
        onClick={() => { if (hasResult) setOpen((value) => !value); }}
        aria-expanded={hasResult ? open : undefined}
        disabled={!hasResult}
        title={hasResult ? (open ? "Hide findings" : "Show findings") : inquiry.title}
      >
        <span className="inquiryCard__glyph" style={{ color: meta.colorVar }} aria-hidden="true">{meta.glyph}</span>
        <span className="inquiryCard__title">{inquiry.title}</span>
        {inquiry.assignee ? <span className="inquiryCard__assignee">@{inquiry.assignee}</span> : null}
        <span className="inquiryCard__status" style={{ color: meta.colorVar }}>{meta.label}</span>
      </button>
      {inquiry.detail ? <p className="inquiryCard__detail">{inquiry.detail}</p> : null}
      {hasResult && open ? (
        <div className="inquiryCard__result">
          {resultBlocks.map((block) => <BlockRenderer key={block.id} block={block} />)}
        </div>
      ) : null}
    </div>
  );
}
