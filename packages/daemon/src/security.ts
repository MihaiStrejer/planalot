import { createHash, randomBytes } from "node:crypto";
import { basename, extname, relative, resolve } from "node:path";

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
  if (clean !== basename(clean)) throw new Error("plan files must be top-level files");
  if (clean.startsWith(".") || clean.includes("..") || clean.includes("/") || clean.includes("\\")) {
    throw new Error("invalid plan file name");
  }

  const ext = extname(clean).toLowerCase();
  if (ext !== ".md" && ext !== ".html") throw new Error("plan files must be .md or .html");
  return clean;
}

export function timingSafeTokenEqual(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.length === b.length && a === b;
}
