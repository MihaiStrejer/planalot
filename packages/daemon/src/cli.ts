#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCcExtension } from "@planalot/cc";
import { installCodexExtension } from "@planalot/codex";
import { installPiExtension } from "@planalot/pi";
import type {
  CreatePlanRequest,
  CreatePlanResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  PlanStatus,
} from "@planalot/shared";
import { openBrowser } from "./browser.js";
import { APP_VERSION, ensureDataDirs, readDaemonMetadata } from "./fsPaths.js";
import { daemonLogPath, startDaemon } from "./server.js";

async function main(): Promise<void> {
  const [, , commandOrPlan, maybePlan] = process.argv;

  if (commandOrPlan === "daemon") {
    const port = Number(process.env.PLANALOT_PORT || 0) || undefined;
    await startDaemon({
      ...(port === undefined ? {} : { port }),
      ...(process.env.PLANALOT_TOKEN === undefined ? {} : { token: process.env.PLANALOT_TOKEN }),
    });
    await new Promise(() => undefined);
    return;
  }

  if (commandOrPlan === "install") {
    const cliPath = fileURLToPath(import.meta.url);
    const force = process.argv.includes("--force");

    if (maybePlan === "pi") {
      const path = await installPiExtension({ cliPath, force });
      console.log(`Installed Pi extension: ${path}`);
      console.log("Restart Pi or run /reload to load Planalot.");
      return;
    }

    if (maybePlan === "cc" || maybePlan === "claude-code") {
      const result = await installCcExtension({ cliPath, force });
      console.log(`Installed Claude Code command: ${result.commandPath}`);
      console.log("Restart Claude Code or reload commands to use /planalot.");
      return;
    }

    if (maybePlan === "codex") {
      const result = await installCodexExtension({ cliPath, force });
      console.log(`Installed Codex plugin: ${result.pluginPath}`);
      console.log(`Updated Codex personal marketplace: ${result.marketplacePath}`);
      console.log("Run `codex plugin add planalot@personal`, then start a new Codex thread to use $planalot.");
      return;
    }

    throw new Error("Usage: planalot install <pi|cc|claude-code|codex> [--force]");
  }

  if (commandOrPlan === "--version" || commandOrPlan === "-v") {
    console.log(APP_VERSION);
    return;
  }

  if (commandOrPlan === "--help" || commandOrPlan === "-h") {
    printHelp();
    return;
  }

  if (isPlanCommand(commandOrPlan)) {
    await runPlanCommand(commandOrPlan, process.argv.slice(3));
    return;
  }

  const planFile = maybePlan ?? commandOrPlan ?? "PLAN.md";
  const daemon = await ensureDaemon();
  const absolutePlanPath = resolve(process.cwd(), planFile);

  if (!existsSync(absolutePlanPath)) {
    throw new Error(`Plan file does not exist: ${planFile}. Create the markdown plan first, then run planalot ${planFile}.`);
  }
  const planText = await readFile(absolutePlanPath, "utf8");

  const body: CreateSessionRequest = {
    runtime: runtimeFromEnv(),
    cwd: process.cwd(),
    planFile,
    planText,
    transport: { kind: runtimeFromEnv() },
  };

  const response = await fetch(`http://127.0.0.1:${daemon.port}/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${daemon.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Failed to create session: ${response.status} ${await response.text()}`);
  const session = (await response.json()) as CreateSessionResponse;
  const opened = openBrowser(session.url);
  console.log(session.url);
  if (!opened) console.error("[planalot] browser did not open automatically; copy the URL above.");
}

async function runPlanCommand(command: string, args: string[]): Promise<void> {
  const daemon = await ensureDaemon();
  const json = args.includes("--json");
  const arg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const has = (name: string): boolean => args.includes(name);

  if (command === "create") {
    const name = arg("--name") ?? "Untitled Plan";
    const text = arg("--text") ?? "# Plan\n";
    const body: CreatePlanRequest = { name, origin: { kind: "text-import" }, indexText: text, runtime: runtimeFromEnv() };
    const result = await apiJson<CreatePlanResponse>(daemon, "/plans", { method: "POST", body });
    printResult(result, json);
    return;
  }

  if (command === "import") {
    const sourcePath = args.find((item) => !item.startsWith("--"));
    if (!sourcePath) throw new Error("Usage: planalot import <path> --name <name> [--json]");
    const body: CreatePlanRequest = {
      name: arg("--name") ?? sourcePath,
      origin: { kind: "file-import", sourcePath: resolve(process.cwd(), sourcePath) },
      runtime: runtimeFromEnv(),
    };
    const result = await apiJson<CreatePlanResponse>(daemon, "/plans", { method: "POST", body });
    printResult(result, json);
    return;
  }

  if (command === "find") {
    const query = args.find((item) => !item.startsWith("--")) ?? "";
    const status = arg("--status");
    const queryString = new URLSearchParams({
      ...(query ? { q: query } : {}),
      ...(status ? { status } : {}),
      ...(has("--include-expired") ? { includeExpired: "true" } : {}),
    }).toString();
    const result = await apiJson(daemon, `/plans${queryString ? `?${queryString}` : ""}`);
    printResult(result, json);
    return;
  }

  if (command === "open") {
    const planId = args[0];
    if (!planId) throw new Error("Usage: planalot open <planId>");
    const url = `http://127.0.0.1:${daemon.port}/s/${encodeURIComponent(planId)}?token=${encodeURIComponent(daemon.token)}`;
    const opened = openBrowser(url);
    console.log(url);
    if (!opened) console.error("[planalot] browser did not open automatically; copy the URL above.");
    return;
  }

  if (command === "show") {
    const planId = requirePlanId(args, command);
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}`), json);
    return;
  }

  if (command === "files") {
    const planId = requirePlanId(args, command);
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/files`), json);
    return;
  }

  if (command === "read") {
    const planId = args[0];
    const file = args[1];
    if (!planId || !file) throw new Error("Usage: planalot read <planId> <file|--all> [--json]");
    if (file === "--all") {
      const plan = await apiJson<{ manifest: { files: Array<{ path: string }> } }>(daemon, `/plans/${encodeURIComponent(planId)}`);
      const files = [];
      for (const entry of plan.manifest.files) {
        files.push(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/files/${encodeURIComponent(entry.path)}`));
      }
      printResult({ files }, json);
      return;
    }
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/files/${encodeURIComponent(file)}`), json);
    return;
  }

  if (command === "write") {
    const planId = args[0];
    const file = args[1];
    if (!planId || !file || !has("--stdin")) throw new Error("Usage: planalot write <planId> <file> --stdin");
    const content = await readStdin();
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/files/${encodeURIComponent(file)}`, { method: "PUT", body: { content } }), json);
    return;
  }

  if (command === "add-file") {
    const planId = args[0];
    const file = args[1];
    if (!planId || !file || !has("--stdin")) throw new Error("Usage: planalot add-file <planId> <file.md|file.html> --purpose <text> --stdin");
    const content = await readStdin();
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/files`, {
      method: "POST",
      body: { path: file, title: arg("--title"), purpose: arg("--purpose"), content },
    }), json);
    return;
  }

  if (command === "feedback") {
    const planId = requirePlanId(args, command);
    const params = has("--open") ? "?status=open" : "";
    const result = await apiJson<{ items: Array<{ status: string }> }>(daemon, `/plans/${encodeURIComponent(planId)}/feedback${params}`);
    printResult(has("--open") ? { items: result.items.filter((item) => item.status === "open") } : result, json);
    return;
  }

  if (command === "add-feedback") {
    const planId = requirePlanId(args, command);
    const text = arg("--text") ?? (has("--stdin") ? await readStdin() : undefined);
    if (!text) throw new Error("Usage: planalot add-feedback <planId> --text <text> [--json]");
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/feedback`, {
      method: "POST",
      body: {
        kind: "chat",
        text,
        ...(arg("--file") ? { filePath: arg("--file") } : {}),
      },
    }), json);
    return;
  }

  if (command === "wait-feedback") {
    const planId = requirePlanId(args, command);
    const timeoutSeconds = Number(arg("--timeout") ?? 600);
    const since = arg("--since");
    const result = await waitForFeedback(daemon, planId, timeoutSeconds, since);
    printResult(result, json);
    return;
  }

  if (command === "resolve-feedback") {
    const planId = args[0];
    const feedbackId = args[1];
    if (!planId || !feedbackId) throw new Error("Usage: planalot resolve-feedback <planId> <feedbackId> [--note <text>]");
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/feedback/${encodeURIComponent(feedbackId)}`, {
      method: "PATCH",
      body: { status: "resolved", ...(arg("--note") ? { resolution: arg("--note") } : {}) },
    }), json);
    return;
  }

  if (command === "implement") {
    const planId = requirePlanId(args, command);
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/implement`, {
      method: "POST",
      body: {
        ...(arg("--target-harness-id") ? { targetHarnessId: arg("--target-harness-id") } : {}),
        ...(has("--allow-open-feedback") ? { allowOpenFeedback: true } : {}),
      },
    }), json);
    return;
  }

  if (command === "status") {
    const planId = args[0];
    const status = args[1] as PlanStatus | undefined;
    if (!planId || !status) throw new Error("Usage: planalot status <planId> <planning|implementing|done|canceled>");
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}`, { method: "PATCH", body: { status } }), json);
    return;
  }

  throw new Error(`Unknown planalot command: ${command}`);
}

function printHelp(): void {
  console.log(`planalot ${APP_VERSION}\n\nUsage:\n  planalot [PLAN.md]\n  planalot daemon\n  planalot create --name <name> [--json]\n  planalot import <path> --name <name> [--json]\n  planalot find <query> [--status planning] [--include-expired] [--json]\n  planalot open <planId>\n  planalot show <planId> [--json]\n  planalot files <planId> [--json]\n  planalot read <planId> <file|--all> [--json]\n  planalot write <planId> <file> --stdin\n  planalot add-file <planId> <file.md|file.html> --purpose <text> --stdin\n  planalot feedback <planId> [--open] [--json]\n  planalot add-feedback <planId> --text <text> [--file <path>] [--json]\n  planalot wait-feedback <planId> [--timeout <seconds>] [--json]\n  planalot resolve-feedback <planId> <feedbackId> [--note <text>]\n  planalot implement <planId> [--target-harness-id <id>] [--allow-open-feedback]\n  planalot status <planId> <planning|implementing|done|canceled>\n  planalot install pi|cc|codex [--force]\n\nStarts or reuses the local planalot daemon. Plan workspaces are stored in ~/.planalot/plans/<id>.`);
}

function runtimeFromEnv(): "codex" | "pi" | "claude-code" | "manual" {
  const runtime = process.env.PLANALOT_RUNTIME;
  if (runtime === "codex" || runtime === "pi" || runtime === "claude-code" || runtime === "manual") return runtime;
  return "manual";
}

async function ensureDaemon(): Promise<{ port: number; token: string }> {
  const existing = await readDaemonMetadata();
  if (existing && (await isHealthy(existing.port, existing.token))) {
    return { port: existing.port, token: existing.token };
  }

  const cliPath = fileURLToPath(import.meta.url);
  const logPath = daemonLogPath();
  await ensureDataDirs();
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [cliPath, "daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  closeSync(logFd);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(150);
    const metadata = await readDaemonMetadata();
    if (metadata && (await isHealthy(metadata.port, metadata.token))) {
      return { port: metadata.port, token: metadata.token };
    }
  }

  throw new Error(`Timed out starting planalot daemon. Check ${logPath}.`);
}

async function isHealthy(port: number, token: string): Promise<boolean> {
  void token;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlanCommand(command: string | undefined): command is string {
  return command !== undefined && [
    "create",
    "import",
    "find",
    "open",
    "show",
    "files",
    "read",
    "write",
    "add-file",
    "feedback",
    "add-feedback",
    "wait-feedback",
    "resolve-feedback",
    "implement",
    "status",
  ].includes(command);
}

function requirePlanId(args: string[], command: string): string {
  const planId = args[0];
  if (!planId) throw new Error(`Usage: planalot ${command} <planId>`);
  return planId;
}

async function apiJson<T = unknown>(
  daemon: { port: number; token: string },
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return await response.json() as T;
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForFeedback(
  daemon: { port: number; token: string },
  planId: string,
  timeoutSeconds: number,
  since?: string,
): Promise<unknown> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const feedback = await apiJson<{ items: Array<{ id: string; createdAt: string }> }>(daemon, `/plans/${encodeURIComponent(planId)}/feedback`);
    const items = since ? feedback.items.filter((item) => item.id > since || item.createdAt > since) : feedback.items;
    if (items.length > 0) return { items, cursor: items.at(-1)?.id };
    await sleep(1000);
  }
  return { items: [], timeout: true, cursor: since };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
