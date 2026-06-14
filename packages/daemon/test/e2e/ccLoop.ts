// Tier C — real Claude Code ↔ planalot extension, the pièce de résistance.
//
// Verifies the undocumented seam: does Claude Code re-invoke the agent when the
// `attach --exit-on-feedback` background task exits? The daemon is the oracle —
// we send feedback and watch the daemon for the agent's reaction; we never parse
// the model's prose. Gated behind PLANALOT_E2E=1 (real binary, billed tokens).
//
// Two modes:
//   AUTO   (default) — spawns `claude -p --input-format stream-json` ourselves
//                      (subscription auth). Tests the HEADLESS streaming path.
//   MANUAL (PLANALOT_E2E_MANUAL=1) — does NOT spawn claude; prints a recipe and
//                      watches while YOU drive a real interactive `claude` TUI.
//                      This is how we test the path users actually run.
//
// Isolation: PLANALOT_DATA_DIR points the daemon + CC's spawned `planalot`
// commands at a throwaway dir; HOME is left alone so CC keeps its real auth. The
// skill is installed PROJECT-LOCALLY, so the user's ~/.claude is never touched.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCcExtension } from "@planalot/cc";
import { userClient, waitFor } from "../fixtures/client.ts";
import { withDaemon, type DaemonHandle } from "../fixtures/daemon.ts";

const DIST_CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const MANUAL = process.env.PLANALOT_E2E_MANUAL === "1";
const RECIPE_FILE = process.env.PLANALOT_E2E_RECIPE;
const ROUNDS = Number(process.env.PLANALOT_E2E_ROUNDS || 1);

const log = (...a: unknown[]): void => { console.log("[e2e]", ...a); };

function preflight(): boolean {
  if (process.env.PLANALOT_E2E !== "1") {
    log("skipped — set PLANALOT_E2E=1 to run the real Claude Code loop probe.");
    return false;
  }
  try { readFileSync(DIST_CLI); } catch {
    log(`FAIL — built CLI missing at ${DIST_CLI}. Run: pnpm --filter @planalot/daemon exec tsc -p tsconfig.json`);
    process.exitCode = 1; return false;
  }
  if (!MANUAL) {
    try { execFileSync("claude", ["--version"], { stdio: "ignore" }); } catch {
      log("FAIL — `claude` not found on PATH."); process.exitCode = 1; return false;
    }
  }
  return true;
}

/** Generate the real cc SKILL.md (via a scratch HOME) and place it project-locally. */
async function installSkillIntoProject(projectDir: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "pl-skill-"));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = scratch;
  process.env.HOME = scratch;
  try {
    await installCcExtension({ cliPath: DIST_CLI, version: "e2e" });
    const src = readFileSync(join(scratch, ".claude", "skills", "planalot", "SKILL.md"), "utf8");
    const dst = join(projectDir, ".claude", "skills", "planalot", "SKILL.md");
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, src, "utf8");
  } finally {
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    rmSync(scratch, { recursive: true, force: true });
  }
}

const attachCmd = (planId: string): string =>
  `node "${DIST_CLI.replace(/\\/g, "/")}" attach ${planId} --type claude-code --drive --exit-on-feedback`;

function kickoff(planId: string): string {
  const cmd = `node "${DIST_CLI.replace(/\\/g, "/")}"`;
  return [
    `Drive Planalot plan ${planId}. Run this as a BACKGROUND task and then wait for it to exit:`,
    `  ${attachCmd(planId)}`,
    `When that background task EXITS, feedback has arrived. Immediately: (1) relaunch the same attach command in the background;`,
    `(2) run \`${cmd} feedback ${planId} --open --json\`; (3) pipe a feedback_result JSON into`,
    `\`${cmd} feedback-result ${planId} --stdin --json\` that resolves every open item (expectsUserFollowUp false).`,
    `Repeat for each round. Start now.`,
  ].join("\n");
}

/** Daemon-side oracle: wait for a CC attach, send a round, confirm the reaction. */
async function observe(d: DaemonHandle, planId: string, attachTimeout: number, wakeTimeout: number): Promise<void> {
  const u = userClient(d);
  let harnessId: string;
  try {
    harnessId = await waitFor(async () => {
      const live = (await u.getSession(planId)).json.harnesses?.find(
        (h: { harnessType: string; status: string }) => h.harnessType === "claude-code" && h.status === "live",
      );
      return live ? (live as { harnessId: string }).harnessId : undefined;
    }, { timeout: attachTimeout, interval: 500, label: "CC attach" });
  } catch {
    log("✗ FAIL — CC never attached. The kickoff did not start the loop."); process.exitCode = 1; return;
  }
  log(`✓ CC attached as ${harnessId}`);

  const latencies: number[] = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const before = ((await u.getFeedback(planId)).json.sessions ?? []).filter((s: { status: string }) => s.status === "closed").length;
    const t0 = Date.now();
    await u.sendFeedback(planId, { targetHarnessId: harnessId, message: `Round ${round}: tighten requirements/index.md.` });
    log(`round ${round}: feedback sent — watching for the wake…`);
    try {
      await waitFor(async () => {
        const closed = ((await u.getFeedback(planId)).json.sessions ?? []).filter((s: { status: string }) => s.status === "closed").length;
        return closed > before ? true : undefined;
      }, { timeout: wakeTimeout, interval: 500, label: `round ${round} reaction` });
      const dt = Date.now() - t0;
      latencies.push(dt);
      log(`✓ round ${round}: CC woke and closed the round in ${dt}ms`);
    } catch {
      log(`✗ round ${round}: NO reaction within ${wakeTimeout}ms — the background-task wake did not fire.`);
      log("  → Signal to move the skill from --exit-on-feedback to the Monitor tool.");
      process.exitCode = 1; return;
    }
  }
  log("──────────────────────────────────────────────");
  log(`PASS — real CC drove ${ROUNDS} round(s) via the background-task wake. latencies(ms): ${latencies.join(", ")}`);
}

function spawnClaudeAuto(projectDir: string, planId: string): { kill: () => void } {
  const child = spawn("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--include-hook-events", "--verbose",
    "--allowedTools", "Bash Read Write BashOutput",
    "--model", process.env.PLANALOT_E2E_MODEL || "sonnet",
    "--setting-sources", "user,project,local",
  ], { cwd: projectDir, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (c: Buffer) => process.stdout.write(c));
  child.stderr.on("data", (c: Buffer) => log("claude!", c.toString("utf8").trim().slice(0, 160)));
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: kickoff(planId) }] } }) + "\n");
  return { kill: () => { try { child.stdin.end(); } catch { /* */ } child.kill(); } };
}

function manualRecipe(d: DaemonHandle, projectDir: string, planId: string): string {
  return [
    "════════════════ INTERACTIVE TUI VERIFICATION ════════════════",
    "The isolated daemon is up and WATCHING. In a SEPARATE terminal:",
    "",
    "  # PowerShell — point CC at the isolated daemon, then start the TUI:",
    `  $env:PLANALOT_DATA_DIR = "${d.dataDir.replace(/\\/g, "/")}"`,
    `  cd "${projectDir.replace(/\\/g, "/")}"`,
    "  claude",
    "",
    "Then paste this into Claude Code and press enter:",
    "",
    kickoff(planId),
    "",
    "This probe will detect the attach, auto-send a feedback round, and report",
    "below whether CC woke. Watch your TUI too: does CC react when the background",
    "attach task exits? (waiting up to 10 min for you to attach.)",
    "═══════════════════════════════════════════════════════════════",
  ].join("\n");
}

async function main(): Promise<void> {
  if (!preflight()) return;
  await withDaemon(async (d) => {
    const projectDir = mkdtempSync(join(tmpdir(), "pl-e2e-proj-"));
    await installSkillIntoProject(projectDir);
    const planId = await userClient(d).createHarnessPlan({ runtime: "claude-code", text: "# E2E Plan\n\nrequirements/index.md is canonical.\n" });
    log("data dir   ", d.dataDir);
    log("project dir", projectDir);
    log("plan       ", planId, "· daemon", d.baseUrl);

    if (MANUAL) {
      const recipe = manualRecipe(d, projectDir, planId);
      if (RECIPE_FILE) writeFileSync(RECIPE_FILE, recipe, "utf8");
      console.log(recipe);
      await observe(d, planId, 600_000, 240_000);
    } else {
      const claude = spawnClaudeAuto(projectDir, planId);
      try { await observe(d, planId, 90_000, 90_000); } finally { claude.kill(); }
    }
    rmSync(projectDir, { recursive: true, force: true });
  });
}

main().catch((err) => { console.error("[e2e] crashed:", err); process.exitCode = 1; });
