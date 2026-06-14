import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AddInquiriesRequest,
  CreateResearchRequest,
  InquiryStatus,
  ResearchInquiry,
  ResearchInquiryInput,
  ResearchSession,
  UpdateInquiryRequest,
  UpdateResearchRequest,
} from "@planalot/shared";
import { researchDir, researchPath } from "./fsPaths.js";

const INQUIRY_STATUSES: readonly InquiryStatus[] = ["open", "active", "blocked", "resolved", "dropped"];

// Serialize read-modify-write per research session. The daemon is single-process,
// so a chained-promise mutex keyed by planId/researchId is enough to keep
// concurrent per-inquiry PATCHes (N subagents) from clobbering each other.
// A failed op never wedges the chain: the stored tail swallows rejections so the
// next queued mutation still runs.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.then(noop, noop));
  return next;
}

function noop(): void {
  /* swallow — the tail only sequences, it must not surface prior errors */
}

export function validateResearchId(id: string): string {
  if (typeof id !== "string" || !/^re_[A-Za-z0-9-]+$/.test(id)) throw new Error("invalid research id");
  return id;
}

export async function createResearch(planId: string, body: CreateResearchRequest): Promise<ResearchSession> {
  const title = (body?.title ?? "").trim();
  if (!title) throw new Error("research title is required");
  const now = new Date().toISOString();
  const research: ResearchSession = {
    id: `re_${randomUUID()}`,
    planId,
    title,
    status: "open",
    scope: typeof body.scope === "string" ? body.scope : "",
    inquiries: normalizeInquiryInputs(body.inquiries).map((input) => newInquiry(input, now)),
    createdAt: now,
    updatedAt: now,
  };
  await writeResearch(planId, research);
  return research;
}

export async function listResearch(planId: string): Promise<ResearchSession[]> {
  const dir = researchDir(planId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const sessions: ResearchSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as ResearchSession;
      sessions.push(normalizeResearch(planId, raw));
    } catch {
      // Skip unreadable/corrupt research files rather than failing the whole list.
    }
  }
  sessions.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return sessions;
}

export async function readResearch(planId: string, researchId: string): Promise<ResearchSession> {
  const id = validateResearchId(researchId);
  const raw = JSON.parse(await readFile(researchPath(planId, id), "utf8")) as ResearchSession;
  return normalizeResearch(planId, raw);
}

export function updateResearchMeta(planId: string, researchId: string, patch: UpdateResearchRequest): Promise<ResearchSession> {
  return mutate(planId, researchId, (research) => {
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title) research.title = title;
    }
    if (patch.status !== undefined) {
      if (patch.status !== "open" && patch.status !== "closed") throw new Error("research status must be open or closed");
      research.status = patch.status;
    }
  });
}

export function updateResearchScope(planId: string, researchId: string, scope: string): Promise<ResearchSession> {
  if (typeof scope !== "string") throw new Error("scope must be a string");
  return mutate(planId, researchId, (research) => {
    research.scope = scope;
  });
}

export function addInquiries(planId: string, researchId: string, body: AddInquiriesRequest): Promise<ResearchSession> {
  const inputs = normalizeInquiryInputs(body?.inquiries);
  if (inputs.length === 0) throw new Error("at least one inquiry is required");
  return mutate(planId, researchId, (research) => {
    const now = new Date().toISOString();
    for (const input of inputs) research.inquiries.push(newInquiry(input, now));
  });
}

export async function updateInquiry(
  planId: string,
  researchId: string,
  inquiryId: string,
  patch: UpdateInquiryRequest,
): Promise<{ research: ResearchSession; inquiry: ResearchInquiry }> {
  let updated: ResearchInquiry | undefined;
  const research = await mutate(planId, researchId, (current) => {
    const inquiry = current.inquiries.find((candidate) => candidate.id === inquiryId);
    if (!inquiry) throw new Error("inquiry not found");
    if (patch.status !== undefined) {
      if (!INQUIRY_STATUSES.includes(patch.status)) throw new Error("invalid inquiry status");
      inquiry.status = patch.status;
    }
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title) inquiry.title = title;
    }
    if (patch.detail !== undefined) {
      const detail = patch.detail.trim();
      if (detail) inquiry.detail = detail;
      else delete inquiry.detail;
    }
    if (patch.assignee !== undefined) {
      const assignee = patch.assignee.trim();
      if (assignee) inquiry.assignee = assignee;
      else delete inquiry.assignee;
    }
    if (patch.result !== undefined) {
      if (patch.result.trim()) inquiry.result = patch.result;
      else delete inquiry.result;
    }
    inquiry.updatedAt = new Date().toISOString();
    updated = inquiry;
  });
  if (!updated) throw new Error("inquiry not found");
  return { research, inquiry: updated };
}

function mutate(planId: string, researchId: string, apply: (research: ResearchSession) => void): Promise<ResearchSession> {
  const id = validateResearchId(researchId);
  return withLock(`${planId}/${id}`, async () => {
    const research = await readResearch(planId, id);
    apply(research);
    research.updatedAt = new Date().toISOString();
    await writeResearch(planId, research);
    return research;
  });
}

async function writeResearch(planId: string, research: ResearchSession): Promise<void> {
  await mkdir(researchDir(planId), { recursive: true, mode: 0o700 });
  await writeFile(researchPath(planId, research.id), `${JSON.stringify(research, null, 2)}\n`, { mode: 0o600 });
}

function newInquiry(input: ResearchInquiryInput, now: string): ResearchInquiry {
  return {
    id: `iq_${randomUUID()}`,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeInquiryInputs(inputs: ResearchInquiryInput[] | undefined): ResearchInquiryInput[] {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs)) throw new Error("inquiries must be an array");
  return inputs.map((input) => {
    const title = (input?.title ?? "").trim();
    if (!title) throw new Error("each inquiry requires a title");
    const detail = typeof input?.detail === "string" ? input.detail.trim() : "";
    return detail ? { title, detail } : { title };
  });
}

function normalizeResearch(planId: string, raw: ResearchSession): ResearchSession {
  const now = new Date().toISOString();
  return {
    id: raw.id,
    planId: raw.planId ?? planId,
    title: raw.title ?? "Untitled research",
    status: raw.status === "closed" ? "closed" : "open",
    scope: typeof raw.scope === "string" ? raw.scope : "",
    inquiries: Array.isArray(raw.inquiries) ? raw.inquiries.map(normalizeInquiry) : [],
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
  };
}

function normalizeInquiry(raw: ResearchInquiry): ResearchInquiry {
  const status = INQUIRY_STATUSES.includes(raw.status) ? raw.status : "open";
  return {
    id: raw.id,
    title: raw.title,
    ...(raw.detail ? { detail: raw.detail } : {}),
    status,
    ...(raw.assignee ? { assignee: raw.assignee } : {}),
    ...(raw.result !== undefined ? { result: raw.result } : {}),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? raw.createdAt,
  };
}
