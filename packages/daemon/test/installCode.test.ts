// Tier A2 — the install/converge code (the authoritative install+update+doctor
// rework). extension-kit mechanics as units, then cc/codex/pi converge against an
// isolated HOME so we never touch the real profile.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  computeInSync,
  convergeRemove,
  convergeWrite,
  dryRunRemoveIfGenerated,
  quoteForShell,
  readSkillRevision,
  readSkillVersion,
} from "../../extension-kit/src/index.ts";
import { checkCcExtension, installCcExtension } from "@planalot/cc";
import { checkCodexExtension, installCodexExtension } from "@planalot/codex";
import { installPiExtension } from "@planalot/pi";

const VERSION = "9.9.9-test";
const CLI = "/opt/planalot/cli.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pl-fs-"));
}

/** Run `fn` with HOME/USERPROFILE pointed at a throwaway dir (os.homedir() reads them live). */
async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const home = tmp();
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

const ccSkill = (home: string): string => join(home, ".claude", "skills", "planalot", "SKILL.md");
const ccCommand = (home: string): string => join(home, ".claude", "commands", "planalot.md");
const codexManifest = (home: string): string => join(home, "plugins", "planalot", ".codex-plugin", "plugin.json");
const codexSkill = (home: string): string => join(home, "plugins", "planalot", "skills", "planalot", "SKILL.md");
const marketplace = (home: string): string => join(home, ".agents", "plugins", "marketplace.json");
const piExt = (home: string): string => join(home, ".pi", "agent", "extensions", "planalot", "index.ts");
const writeFileDeep = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
};
const stepFor = (report: { steps: Array<{ path: string; action: string }> }, path: string): string | undefined =>
  report.steps.find((s) => s.path === path)?.action;

// ── extension-kit units ──────────────────────────────────────────────────────

test("convergeWrite: wrote → unchanged → updated, creating parent dirs", async () => {
  const path = join(tmp(), "nested", "deep", "file.txt");
  assert.equal(await convergeWrite(path, "a", true), "wrote");
  assert.ok(existsSync(path));
  assert.equal(await convergeWrite(path, "a", true), "unchanged");
  assert.equal(await convergeWrite(path, "b", true), "updated");
  assert.equal(readFileSync(path, "utf8"), "b");
});

test("convergeRemove: removed (marked), left-foreign (unmarked, kept), absent", async () => {
  const marker = "OWNED-BY-PLANALOT";
  const owned = join(tmp(), "owned.md");
  writeFileSync(owned, `# x\n${marker}\n`, "utf8");
  assert.equal(await convergeRemove(owned, marker, true), "removed");
  assert.ok(!existsSync(owned));

  const foreign = join(tmp(), "foreign.md");
  writeFileSync(foreign, "# someone else's file\n", "utf8");
  assert.equal(dryRunRemoveIfGenerated(foreign, marker), "left-foreign");
  assert.equal(await convergeRemove(foreign, marker, true), "left-foreign");
  assert.ok(existsSync(foreign), "foreign file must be preserved");

  assert.equal(await convergeRemove(join(tmp(), "missing.md"), marker, true), "absent");
});

test("computeInSync: true iff every step is non-mutating (drift excluded)", () => {
  assert.equal(computeInSync([{ path: "a", action: "unchanged" }, { path: "b", action: "absent" }, { path: "c", action: "left-foreign" }]), true);
  assert.equal(computeInSync([{ path: "a", action: "unchanged" }, { path: "b", action: "wrote" }]), false);
  assert.equal(computeInSync([{ path: "a", action: "removed" }]), false);
});

test("readSkillVersion/Revision: frontmatter and HTML-comment (inside a /* */ banner)", () => {
  const fm = join(tmp(), "fm.md");
  writeFileSync(fm, "---\nplanalot_version: 1.2.3\nplanalot_skill_revision: rev-x\n---\n# body\n", "utf8");
  assert.equal(readSkillVersion(fm), "1.2.3");
  assert.equal(readSkillRevision(fm), "rev-x");

  const banner = join(tmp(), "ext.ts");
  writeFileSync(banner, "/**\n * <!-- planalot_version: 4.5.6 -->\n * <!-- planalot_skill_revision: pi-attach-v1 -->\n */\nconst x = 1;\n", "utf8");
  assert.equal(readSkillVersion(banner), "4.5.6");
  assert.equal(readSkillRevision(banner), "pi-attach-v1");
});

test("quoteForShell: leaves bare paths, quotes paths with spaces", () => {
  assert.equal(quoteForShell("/usr/bin/node"), "/usr/bin/node");
  assert.equal(quoteForShell("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
});

// ── cc converge ──────────────────────────────────────────────────────────────

test("cc: install writes skill, --check reports in sync, re-install is idempotent", async () => {
  await withHome(async (home) => {
    const r1 = await installCcExtension({ cliPath: CLI, version: VERSION });
    assert.equal(stepFor(r1, ccSkill(home)), "wrote");
    assert.equal(stepFor(r1, ccCommand(home)), "absent");
    assert.equal(r1.inSync, false, "first apply mutates owned resources");
    assert.equal(readSkillVersion(ccSkill(home)), VERSION);
    assert.equal(readSkillRevision(ccSkill(home)), "wake-on-feedback-v1");

    const check = await checkCcExtension({ cliPath: CLI, version: VERSION });
    assert.equal(check.inSync, true);

    const r2 = await installCcExtension({ cliPath: CLI, version: VERSION });
    assert.equal(stepFor(r2, ccSkill(home)), "unchanged");
    assert.equal(r2.inSync, true);
  });
});

test("cc: removes a planted MARKER command, preserves a foreign one", async () => {
  await withHome(async (home) => {
    await installCcExtension({ cliPath: CLI, version: VERSION });

    // A stray command we generated in the past → removed on converge.
    writeFileDeep(ccCommand(home), "# planalot\nGenerated by planalot install cc.\n");
    const removed = await installCcExtension({ cliPath: CLI, version: VERSION });
    assert.equal(stepFor(removed, ccCommand(home)), "removed");
    assert.equal(removed.inSync, false);
    assert.ok(!existsSync(ccCommand(home)), "marked command should be deleted");
    assert.equal((await checkCcExtension({ cliPath: CLI, version: VERSION })).inSync, true);

    // A user's own /planalot command (no marker) → left untouched.
    writeFileDeep(ccCommand(home), "# my own planalot command\n");
    const kept = await installCcExtension({ cliPath: CLI, version: VERSION });
    assert.equal(stepFor(kept, ccCommand(home)), "left-foreign");
    assert.equal(kept.inSync, true, "left-foreign is non-mutating");
    assert.ok(existsSync(ccCommand(home)), "foreign command must be preserved");
  });
});

// ── codex converge ───────────────────────────────────────────────────────────

test("codex: install writes manifest+skill, cache drift is advisory (inSync unaffected)", async () => {
  await withHome(async (home) => {
    const r1 = await installCodexExtension({ cliPath: CLI, version: VERSION });
    assert.equal(stepFor(r1, codexManifest(home)), "wrote");
    assert.equal(stepFor(r1, codexSkill(home)), "wrote");
    assert.equal(r1.inSync, false);
    assert.equal(readSkillVersion(codexSkill(home)), VERSION);

    // Idempotent re-install: owned resources unchanged ⇒ inSync true, but the
    // (never-populated) codex cache is reported as advisory drift.
    const r2 = await installCodexExtension({ cliPath: CLI, version: VERSION });
    assert.equal(r2.inSync, true, "owned resources in sync");
    assert.ok(r2.drift.length > 0, "uncached codex install surfaces advisory drift");
  });
});

test("codex: marketplace upsert preserves foreign entries and unknown top-level fields", async () => {
  await withHome(async (home) => {
    writeFileDeep(marketplace(home), JSON.stringify({
      name: "personal",
      customField: "keep-me",
      plugins: [
        { name: "other-plugin", source: { source: "local", path: "./plugins/other" } },
        { name: "planalot", source: { source: "local", path: "./STALE/path" }, category: "Stale" },
      ],
    }, null, 2) + "\n");

    await installCodexExtension({ cliPath: CLI, version: VERSION });

    const after = JSON.parse(readFileSync(marketplace(home), "utf8"));
    assert.equal(after.customField, "keep-me", "unknown top-level field preserved");
    const names = after.plugins.map((p: { name: string }) => p.name);
    assert.ok(names.includes("other-plugin"), "foreign plugin preserved");
    const ours = after.plugins.find((p: { name: string }) => p.name === "planalot");
    assert.equal(ours.source.path, "./plugins/planalot", "our entry converged to canonical path");
    assert.equal(ours.category, "Productivity");
  });
});

// ── pi converge ──────────────────────────────────────────────────────────────

test("pi: install embeds version + revision tokens in the extension banner", async () => {
  await withHome(async (home) => {
    const r1 = await installPiExtension({ cliPath: CLI, version: VERSION });
    assert.equal(stepFor(r1, piExt(home)), "wrote");
    const src = readFileSync(piExt(home), "utf8");
    assert.ok(src.includes(`<!-- planalot_version: ${VERSION} -->`));
    assert.ok(src.includes("<!-- planalot_skill_revision: pi-attach-v1 -->"));
    assert.ok(src.includes(`const PLANALOT_VERSION = ${JSON.stringify(VERSION)}`));
    assert.equal(readSkillVersion(piExt(home)), VERSION);
    assert.equal(readSkillRevision(piExt(home)), "pi-attach-v1");

    assert.equal((await installPiExtension({ cliPath: CLI, version: VERSION })).inSync, true);
  });
});
