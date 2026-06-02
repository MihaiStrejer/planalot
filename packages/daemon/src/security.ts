import { createHash, randomBytes } from "node:crypto";
import { basename, extname, relative, resolve } from "node:path";
import type { PlanLayer } from "@planalot/shared";

export function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function validatePlanPath(cwd: string, planFile: string): string {
  if (!cwd || !planFile) throw new Error("cwd and planFile are required");
  const resolvedCwd = resolve(cwd);
  const absolutePlanPath = resolve(resolvedCwd, planFile);
  const rel = relative(resolvedCwd, absolutePlanPath);

  if (rel === "" || rel.startsWith("..") || rel.includes("..\\") || rel.includes("../")) {
    throw new Error("planFile must resolve inside cwd");
  }

  const ext = extname(absolutePlanPath).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") {
    throw new Error("planFile must be a .md or .mdx file");
  }

  return absolutePlanPath;
}

export function validateWorkspaceFileName(filePath: string): string {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("file path is required");
  const clean = filePath.trim();
  if (clean.includes("\\") || clean.includes("..")) throw new Error("invalid plan file path");
  const parts = clean.split("/");
  if (parts.length !== 2) throw new Error("plan files must be stored as <requirements|design|tasks>/<file>");
  const [layer, name] = parts;
  if (!isPlanLayer(layer)) throw new Error("plan file layer must be requirements, design, or tasks");
  if (!name || name !== basename(name) || name.startsWith(".")) throw new Error("invalid plan file name");

  const ext = extname(name).toLowerCase();
  if (ext !== ".md" && ext !== ".html") throw new Error("plan files must be .md or .html");
  return clean;
}

export function layerFromWorkspaceFileName(filePath: string): PlanLayer {
  return validateWorkspaceFileName(filePath).split("/", 1)[0] as PlanLayer;
}

export function isPlanLayer(value: unknown): value is PlanLayer {
  return value === "requirements" || value === "design" || value === "tasks";
}

export function timingSafeTokenEqual(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.length === b.length && a === b;
}
