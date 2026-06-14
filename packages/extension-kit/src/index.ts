// Shared mechanics for the per-harness Planalot installers (cc / codex / pi).
//
// Philosophy: planalot is AUTHORITATIVE over the resources it owns inside each
// harness. `install` converges those resources to the running version, repairs
// drift, and surgically cleans up our own legacy artifacts — without ever
// touching files we don't own. Authority is scoped by ownership class:
//   - Owned folder  → always (re)write (writeGeneratedFile). No marker guard.
//   - Shared dir    → touch only ours, identified by MARKER (removeIfGenerated)
//                     or by name (the marketplace upsert, in the codex package).
//
// Every installer builds a ConvergeReport; the same code path serves `install`
// (apply) and `--check` (dry-run) by toggling one `apply` flag.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Harness = "cc" | "codex" | "pi";

/**
 * What a converge step did (apply) or would do (check).
 * - wrote/updated/unchanged: an owned file we (re)write authoritatively.
 * - removed/absent/left-foreign: a marker-scoped removal in a shared dir.
 *   left-foreign = a file exists at our path but is not ours, so we leave it.
 */
export type ConvergeAction = "wrote" | "updated" | "unchanged" | "removed" | "absent" | "left-foreign";

export interface ConvergeStep {
  path: string;
  action: ConvergeAction;
  note?: string;
}

/** Drift we surface but cannot fix from the installer (e.g. the codex cache). */
export interface UnfixableDrift {
  path: string;
  reason: string;
}

export interface ConvergeReport {
  harness: Harness;
  mode: "apply" | "check";
  version: string;
  steps: ConvergeStep[];
  drift: UnfixableDrift[];
  /** Owned-resource verdict only — `drift` is advisory and never affects this. */
  inSync: boolean;
}

const NON_MUTATING: ReadonlySet<ConvergeAction> = new Set<ConvergeAction>(["unchanged", "absent", "left-foreign"]);

/** In sync iff every owned-resource step is non-mutating. Cache drift is excluded by design. */
export function computeInSync(steps: ConvergeStep[]): boolean {
  return steps.every((step) => NON_MUTATING.has(step.action));
}

// ── Owned resources: authoritative (re)write, no marker guard ────────────────

/** Decide the action a write would take, without touching disk. */
export function dryRunWrite(path: string, content: string): "wrote" | "updated" | "unchanged" {
  if (!existsSync(path)) return "wrote";
  return readFileSync(path, "utf8") === content ? "unchanged" : "updated";
}

/**
 * Authoritatively (re)write a generated file. Creates parent dirs (0o700) and
 * skips the write when content already matches. No marker check — we own this
 * path, so a foreign file here is stale and gets converged.
 */
export async function writeGeneratedFile(path: string, content: string): Promise<"wrote" | "updated" | "unchanged"> {
  const action = dryRunWrite(path, content);
  if (action === "unchanged") return action;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, "utf8");
  return action;
}

// ── Shared dirs: touch only ours (marker-scoped) ─────────────────────────────

export function fileHasMarker(path: string, marker: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(marker);
}

/** Decide what a marker-scoped removal would do, without touching disk. */
export function dryRunRemoveIfGenerated(path: string, marker: string): "removed" | "absent" | "left-foreign" {
  if (!existsSync(path)) return "absent";
  return fileHasMarker(path, marker) ? "removed" : "left-foreign";
}

/** Delete a file only if it exists AND carries our marker — never a foreign file at the same path. */
export async function removeIfGenerated(path: string, marker: string): Promise<"removed" | "absent" | "left-foreign"> {
  const action = dryRunRemoveIfGenerated(path, marker);
  if (action === "removed") await rm(path, { force: true });
  return action;
}

// ── apply/check helpers (one call site, toggled by `apply`) ──────────────────

export async function convergeWrite(path: string, content: string, apply: boolean): Promise<ConvergeAction> {
  return apply ? await writeGeneratedFile(path, content) : dryRunWrite(path, content);
}

export async function convergeRemove(path: string, marker: string, apply: boolean): Promise<ConvergeAction> {
  return apply ? await removeIfGenerated(path, marker) : dryRunRemoveIfGenerated(path, marker);
}

// ── Version / revision probes (frontmatter + HTML-comment fallback) ──────────

/** Read `key: value` from YAML frontmatter, falling back to an `<!-- key: value -->` comment. */
function readTaggedValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8");
  const frontmatter = content.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, "m"));
  if (frontmatter?.[1]) return frontmatter[1].trim();
  const comment = content.match(new RegExp(`<!--\\s*${key}:\\s*([^>\\r\\n]+)\\s*-->`));
  return comment?.[1]?.trim();
}

export function readSkillVersion(path: string): string | undefined {
  return readTaggedValue(path, "planalot_version");
}

export function readSkillRevision(path: string): string | undefined {
  return readTaggedValue(path, "planalot_skill_revision");
}

export function readManifestVersion(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

// ── Shell quoting for embedding the CLI path into generated skill snippets ───

export function quoteForShell(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function shellCommandForCli(cliPath: string): string {
  const node = quoteForShell(process.execPath);
  const cli = quoteForShell(cliPath);
  return `${node} ${cli}`;
}
