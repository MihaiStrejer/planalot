#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCcExtension, installCcExtension } from "@planalot/cc";
import { checkCodexExtension, installCodexExtension } from "@planalot/codex";
import { checkPiExtension, installPiExtension } from "@planalot/pi";
import type {
  CreatePlanRequest,
  CreatePlanResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  HarnessAttachResponse,
  HarnessHeartbeatResponse,
  PlanStatus,
} from "@planalot/shared";
import { openBrowser } from "./browser.js";
import { APP_VERSION, ensureDataDirs, harnessNamePath, harnessStatePath, readDaemonMetadata } from "./fsPaths.js";
import { daemonLogPath, startDaemon } from "./server.js";

/** Converge report shape returned by every harness install/check (from @planalot/extension-kit). */
type ConvergeReport = Awaited<ReturnType<typeof installCcExtension>>;
type ConvergeFn = (options: { cliPath: string; version: string }) => Promise<ConvergeReport>;

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
    const check = process.argv.includes("--check");
    const json = process.argv.includes("--json");
    // No --force: install is authoritative over the resources planalot owns. A
    // stray --force is simply ignored.

    const harnesses: Record<string, { install: ConvergeFn; check: ConvergeFn; nextStep: string }> = {
      cc: { install: installCcExtension, check: checkCcExtension, nextStep: "Use /planalot in Claude Code (restart it if the skills directory did not already exist)." },
      "claude-code": { install: installCcExtension, check: checkCcExtension, nextStep: "Use /planalot in Claude Code (restart it if the skills directory did not already exist)." },
      codex: { install: installCodexExtension, check: checkCodexExtension, nextStep: "Run `codex plugin add planalot@personal`, then start a new Codex thread to use $planalot." },
      pi: { install: installPiExtension, check: checkPiExtension, nextStep: "Restart Pi or run /reload to load Planalot." },
    };

    const harness = maybePlan ? harnesses[maybePlan] : undefined;
    if (!harness) {
      throw new Error("Usage: planalot install <pi|cc|claude-code|codex> [--check] [--json]");
    }

    if (check) {
      const report = await harness.check({ cliPath, version: APP_VERSION });
      printConvergeReport(report, json);
      process.exitCode = report.inSync ? 0 : 1;
      return;
    }

    const report = await harness.install({ cliPath, version: APP_VERSION });
    printConvergeReport(report, json);
    if (!json) console.log(harness.nextStep);
    return;
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
    if (!planId || !file || !has("--stdin")) throw new Error("Usage: planalot write <planId> <file> --stdin [--harness-id <id>]");
    const content = await readStdin();
    const harnessId = await resolveHarnessId(planId, arg("--harness-id"));
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/files/${encodeURIComponent(file)}`, { method: "PUT", body: { content }, headers: harnessHeader(harnessId) }), json);
    return;
  }

  if (command === "add-file") {
    const planId = args[0];
    const file = args[1];
    if (!planId || !file || !has("--stdin")) throw new Error("Usage: planalot add-file <planId> <file.md|file.html> --purpose <text> --stdin [--harness-id <id>]");
    const content = await readStdin();
    const harnessId = await resolveHarnessId(planId, arg("--harness-id"));
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/files`, {
      method: "POST",
      body: { path: file, title: arg("--title"), purpose: arg("--purpose"), content },
      headers: harnessHeader(harnessId),
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

  if (command === "feedback-result") {
    const planId = requirePlanId(args, command);
    if (!has("--stdin")) throw new Error("Usage: planalot feedback-result <planId> --stdin [--harness-id <id>] [--json]");
    const result = JSON.parse(await readStdin()) as unknown;
    const harnessId = await resolveHarnessId(planId, arg("--harness-id"));
    printResult(await apiJson(daemon, `/sessions/${encodeURIComponent(planId)}/feedback-result`, {
      method: "POST",
      body: { result },
      headers: harnessHeader(harnessId),
    }), json);
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

  if (command === "research-new") {
    const planId = args[0];
    const title = arg("--title");
    if (!planId || !title) throw new Error("Usage: planalot research-new <planId> --title <title> [--scope-stdin] [--json]");
    const scope = has("--scope-stdin") || has("--stdin") ? await readStdin() : arg("--scope");
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/research`, {
      method: "POST",
      body: { title, ...(scope !== undefined ? { scope } : {}) },
    }), json);
    return;
  }

  if (command === "research-list") {
    const planId = requirePlanId(args, command);
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/research`), json);
    return;
  }

  if (command === "research-show") {
    const planId = args[0];
    const rid = args[1];
    if (!planId || !rid) throw new Error("Usage: planalot research-show <planId> <researchId> [--json]");
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/research/${encodeURIComponent(rid)}`), json);
    return;
  }

  if (command === "research-add") {
    const planId = args[0];
    const rid = args[1];
    if (!planId || !rid) throw new Error("Usage: planalot research-add <planId> <researchId> (--stdin | --title <t> [--detail <d>]) [--json]");
    let inquiries: Array<{ title: string; detail?: string }>;
    if (has("--stdin")) {
      const parsed = JSON.parse(await readStdin()) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as { inquiries?: unknown }).inquiries;
      if (!Array.isArray(list)) throw new Error('research-add --stdin expects a JSON array of {title, detail?} (or {"inquiries":[...]})');
      inquiries = list as Array<{ title: string; detail?: string }>;
    } else {
      const title = arg("--title");
      if (!title) throw new Error("research-add requires --stdin or --title");
      const detail = arg("--detail");
      inquiries = [{ title, ...(detail ? { detail } : {}) }];
    }
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/research/${encodeURIComponent(rid)}/inquiries`, {
      method: "POST",
      body: { inquiries },
    }), json);
    return;
  }

  if (command === "research-update") {
    const planId = args[0];
    const rid = args[1];
    const iid = args[2];
    if (!planId || !rid || !iid) {
      throw new Error("Usage: planalot research-update <planId> <researchId> <inquiryId> [--status <s>] [--assignee <a>] [--title <t>] [--detail <d>] [--result-stdin] [--json]");
    }
    const result = has("--result-stdin") ? await readStdin() : arg("--result");
    const body = {
      ...(arg("--status") ? { status: arg("--status") } : {}),
      ...(arg("--assignee") ? { assignee: arg("--assignee") } : {}),
      ...(arg("--title") ? { title: arg("--title") } : {}),
      ...(arg("--detail") ? { detail: arg("--detail") } : {}),
      ...(result !== undefined ? { result } : {}),
    };
    if (Object.keys(body).length === 0) {
      throw new Error("research-update needs at least one of --status/--assignee/--title/--detail/--result-stdin");
    }
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/research/${encodeURIComponent(rid)}/inquiries/${encodeURIComponent(iid)}`, {
      method: "PATCH",
      body,
    }), json);
    return;
  }

  if (command === "research-scope") {
    const planId = args[0];
    const rid = args[1];
    if (!planId || !rid || !has("--stdin")) throw new Error("Usage: planalot research-scope <planId> <researchId> --stdin [--json]");
    const scope = await readStdin();
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/research/${encodeURIComponent(rid)}/scope`, {
      method: "PUT",
      body: { scope },
    }), json);
    return;
  }

  if (command === "attach") {
    const planId = args[0];
    if (!planId) throw new Error("Usage: planalot attach <planId> [--drive] [--name <text>] [--type <runtime>] [--harness-id <id>] [--exit-on-feedback]");
    const harnessType = arg("--type") ?? runtimeFromEnv();
    const drive = has("--drive");
    // Exit cleanly (without detaching) the moment an actionable event arrives,
    // so a harness whose runtime only re-invokes the agent on process exit
    // (e.g. Claude Code background tasks) is woken to handle it. Presence churn
    // (harness.presence) is suppressed and never counts as actionable.
    const exitOnFeedback = has("--exit-on-feedback");
    const cwd = process.cwd();
    // Name precedence: explicit --name/--label → this plan's stored name →
    // this cwd's stored name → (omit, let the server assign a friendly one).
    const explicitName = arg("--name") ?? arg("--label");
    const emitLine = (value: unknown): void => console.log(JSON.stringify(value));

    const doAttach = async (): Promise<HarnessAttachResponse> => {
      const state = await readHarnessState(planId);
      const requestedId = arg("--harness-id") ?? state?.harnessId;
      const requestedName = explicitName ?? state?.name ?? (await readCwdName(cwd));
      const attached = await apiJson<HarnessAttachResponse>(daemon, `/plans/${encodeURIComponent(planId)}/harness/attach`, {
        method: "POST",
        body: { harnessType, ...(requestedName ? { label: requestedName } : {}), ...(requestedId ? { harnessId: requestedId } : {}), drive },
      });
      await writeHarnessState(planId, { harnessId: attached.harnessId, name: attached.label });
      await writeCwdName(cwd, attached.label).catch(() => undefined);
      return attached;
    };

    let attached = await doAttach();
    const harnessId = attached.harnessId;
    let cursor = attached.cursor;
    emitLine({ type: "attached", harnessId, name: attached.label, role: attached.role, roster: attached.roster, ...(attached.editLease ? { editLease: attached.editLease } : {}) });

    let stopping = false;
    const detach = async (): Promise<void> => {
      try {
        await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/harness/${encodeURIComponent(harnessId)}/detach`, { method: "POST" });
      } catch { /* daemon may already be gone */ }
      await removeHarnessState(planId).catch(() => undefined);
    };
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      void detach().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGHUP", shutdown);

    // True when the attach-state file no longer names us — an external `detach`
    // removed it, or a newer attach took over. Lets `detach` stop this loop
    // cross-platform (no reliable POSIX signals on Windows).
    const supersededExternally = async (): Promise<boolean> => {
      const state = await readHarnessState(planId);
      return !state || state.harnessId !== harnessId;
    };

    // Heartbeat doubles as the receive channel: a long-poll that returns
    // immediately when feedback (or any targeted event) arrives, else after the
    // server's long-poll budget — and either way refreshes liveness.
    while (!stopping) {
      try {
        const hb = await apiJson<HarnessHeartbeatResponse>(daemon, `/plans/${encodeURIComponent(planId)}/harness/${encodeURIComponent(harnessId)}/heartbeat`, {
          method: "POST",
          body: { cursor, waitMs: 25_000 },
        });
        cursor = hb.cursor;
        let woke = false;
        for (const event of hb.events) {
          // In exit-on-feedback mode, presence churn is noise — drop it and keep
          // heartbeating. Any other targeted event (feedback.sent, feedback.answered,
          // plan.build, plan.accepted, implementation.requested) is something the
          // agent must act on: print it and exit so the runtime re-invokes the agent.
          if (exitOnFeedback && (event as { type?: string }).type === "harness.presence") continue;
          emitLine(event);
          if (exitOnFeedback) woke = true;
        }
        // Clean exit (no detach): the harness stays registered for presence and is
        // resumed by the next attach, which replays anything queued in the gap.
        if (woke) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("404")) {
          // 404 = detached or evicted. If we were detached externally, stop;
          // otherwise (transient eviction / daemon restart) re-attach.
          if (await supersededExternally()) { emitLine({ type: "detached", harnessId }); return; }
          attached = await doAttach();
          cursor = attached.cursor;
          emitLine({ type: "reattached", harnessId, role: attached.role, roster: attached.roster });
          continue;
        }
        emitLine({ type: "attach-error", error: message });
        await sleep(1_000);
      }
      if (await supersededExternally()) { emitLine({ type: "detached", harnessId }); return; }
    }
    return;
  }

  if (command === "detach") {
    const planId = args[0];
    if (!planId) throw new Error("Usage: planalot detach <planId> [--harness-id <id>]");
    const harnessId = await resolveHarnessId(planId, arg("--harness-id"));
    if (!harnessId) throw new Error("No attached harness id found for this plan. Pass --harness-id <id>.");
    // Remove the state file FIRST so a running `attach` loop sees itself
    // superseded and exits instead of re-attaching when the server detach
    // wakes its long-poll.
    await removeHarnessState(planId).catch(() => undefined);
    printResult(await apiJson(daemon, `/plans/${encodeURIComponent(planId)}/harness/${encodeURIComponent(harnessId)}/detach`, { method: "POST" }), json);
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
  console.log(`planalot ${APP_VERSION}\n\nUsage:\n  Create a plan workspace (returns a plan id):\n    planalot create --name <name> [--json]\n    planalot import <path> --name <name> [--json]\n    planalot [PLAN.md]    shortcut: import a markdown file into a new plan workspace and open it\n\n  Work with a plan by id:\n    planalot find <query> [--status planning] [--include-expired] [--json]\n    planalot open <planId>\n    planalot show <planId> [--json]\n    planalot files <planId> [--json]\n    planalot read <planId> <requirements/file.md|design/file.md|tasks/file.md|--all> [--json]\n    planalot write <planId> <requirements/file.md|design/file.md|tasks/file.md> --stdin\n    planalot add-file <planId> <requirements/file.md|design/file.md|tasks/file.md|file.html> --purpose <text> --stdin\n    planalot status <planId> <planning|implementing|done|canceled>\n    planalot implement <planId> [--target-harness-id <id>] [--allow-open-feedback]\n\n  Research (lease-exempt parallel inquiries):\n    planalot research-new <planId> --title <t> [--scope-stdin]\n    planalot research-list <planId> [--json]\n    planalot research-show <planId> <researchId> [--json]\n    planalot research-add <planId> <researchId> (--stdin <JSON array of {title,detail?}> | --title <t> [--detail <d>])\n    planalot research-update <planId> <researchId> <inquiryId> [--status open|active|blocked|resolved|dropped] [--assignee <a>] [--result-stdin]\n    planalot research-scope <planId> <researchId> --stdin\n\n  Feedback:\n    planalot feedback <planId> [--open] [--json]\n    planalot add-feedback <planId> --text <text> [--file <path>] [--json]\n    planalot wait-feedback <planId> [--timeout <seconds>] [--json]\n    planalot feedback-result <planId> --stdin [--harness-id <id>] [--json]\n    planalot resolve-feedback <planId> <feedbackId> [--note <text>]\n\n  Harness / daemon:\n    planalot attach <planId> [--drive] [--name <text>] [--type <runtime>] [--harness-id <id>] [--exit-on-feedback]\n    planalot detach <planId> [--harness-id <id>]\n    planalot daemon\n    planalot install <pi|cc|codex> [--check] [--json]   (install = update + repair + report; --check is a dry run)\n\nPlans live in ~/.planalot/plans/<id>. create/import (and the 'planalot PLAN.md' shortcut) mint a\nnew plan id; from then on Planalot owns the source of truth and you work by id - open/show/read/\nwrite/implement <planId>. 'planalot PLAN.md' imports the file once; it does not keep syncing a file by name.\n\nattach is long-running: it registers this harness (heartbeat + receive) and prints\nfeedback events as JSON lines until stopped. Run it in the background while planning.\nWith --exit-on-feedback it instead exits (staying registered) the moment an actionable\nevent arrives, so a runtime that only re-invokes the agent on process exit (e.g. Claude\nCode background tasks) is woken; relaunch it after handling the event.`);
}

function printConvergeReport(report: ConvergeReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const verb: Record<string, string> = report.mode === "check"
    ? { wrote: "would create", updated: "would update", unchanged: "ok", removed: "would remove", absent: "ok (absent)", "left-foreign": "left (not ours)" }
    : { wrote: "created", updated: "updated", unchanged: "unchanged", removed: "removed", absent: "absent", "left-foreign": "left (not ours)" };

  console.log(`planalot install ${report.harness} — v${report.version} (${report.mode})`);
  for (const step of report.steps) {
    console.log(`  ${verb[step.action] ?? step.action}  ${step.path}${step.note ? `  — ${step.note}` : ""}`);
  }
  // Advisory only — codex runs from its own cache, which the installer can't write.
  // Never affects the in-sync verdict below.
  if (report.drift.length > 0) {
    console.log("  Reload needed (the harness runs its own cached copy, not our files):");
    for (const drift of report.drift) console.log(`    • ${drift.path} — ${drift.reason}`);
  }
  if (report.mode === "check") {
    console.log(report.inSync ? "in sync" : "out of sync");
  } else {
    console.log(report.inSync ? "already up to date" : "done");
  }
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
    "feedback-result",
    "resolve-feedback",
    "implement",
    "research-new",
    "research-list",
    "research-show",
    "research-add",
    "research-update",
    "research-scope",
    "attach",
    "detach",
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
  options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
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
  const text = Buffer.concat(chunks).toString("utf8");
  // Strip a leading UTF-8 BOM — Windows shells (PowerShell) prepend one when
  // piping to a child's stdin, which otherwise breaks JSON.parse and leaks into
  // stored file/scope content.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface HarnessState {
  harnessId: string;
  name?: string;
}

async function readHarnessState(planId: string): Promise<HarnessState | undefined> {
  try {
    return JSON.parse(await readFile(harnessStatePath(planId), "utf8")) as HarnessState;
  } catch {
    return undefined;
  }
}

async function writeHarnessState(planId: string, state: HarnessState): Promise<void> {
  const path = harnessStatePath(planId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function removeHarnessState(planId: string): Promise<void> {
  await rm(harnessStatePath(planId), { force: true });
}

/** Per-cwd friendly name, so this harness instance keeps its name across plans. */
async function readCwdName(cwd: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(harnessNamePath(cwd), "utf8")) as { name?: string };
    return typeof parsed.name === "string" && parsed.name ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

async function writeCwdName(cwd: string, name: string): Promise<void> {
  const path = harnessNamePath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ name }, null, 2)}\n`, { mode: 0o600 });
}

/** Resolve the harnessId a mutating CLI call should claim: flag wins, else the attach-state file. */
async function resolveHarnessId(planId: string, explicit?: string): Promise<string | undefined> {
  return explicit ?? (await readHarnessState(planId))?.harnessId;
}

function harnessHeader(harnessId?: string): Record<string, string> {
  return harnessId ? { "x-planalot-harness-id": harnessId } : {};
}

async function waitForFeedback(
  daemon: { port: number; token: string },
  planId: string,
  timeoutSeconds: number,
  since?: string,
): Promise<unknown> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const feedback = await apiJson<{
      items: Array<{ id: string; createdAt: string }>;
      sessions?: Array<{ id: string; createdAt: string; status: string; requestMarkdown: string }>;
    }>(daemon, `/plans/${encodeURIComponent(planId)}/feedback`);
    const sessions = (feedback.sessions ?? []).filter((session) =>
      session.status === "open" && (since ? session.id > since || session.createdAt > since : true)
    );
    if (sessions.length > 0) return { sessions, cursor: sessions.at(-1)?.id };
    const items = since ? feedback.items.filter((item) => item.id > since || item.createdAt > since) : feedback.items;
    if (items.length > 0) return { items, cursor: items.at(-1)?.id };
    await sleep(1000);
  }
  return { sessions: [], items: [], timeout: true, cursor: since };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
