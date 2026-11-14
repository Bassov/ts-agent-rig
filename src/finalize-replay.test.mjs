import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultExec,
  FINALIZE_STAGE_TIMEOUT_MS,
  finishStrykerGate,
  run,
} from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.join(here, "..", "testdata", "finalize-cases");
const readCase = (name) => fs.readFileSync(path.join(CASES, name), "utf8");

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length)
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function finalizeRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-replay-"));
  tmpDirs.push(d);
  fs.writeFileSync(path.join(d, ".nvmrc"), "22\n");
  fs.mkdirSync(path.join(d, "openspec", "changes"), { recursive: true });
  fs.mkdirSync(path.join(d, ".git"), { recursive: true });
  return d;
}

/**
 * Host stub for `agent finalize`: git answers for a clean branch `fix/demo`
 * at `state.head`; stage scripts answer from `state.stages`.
 */
function hostExec(state) {
  const calls = [];
  const exec = (file, args, opts = {}) => {
    const key = `${file} ${args.join(" ")}`;
    calls.push({ key, env: opts.env, timeout: opts.timeout });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (key === "node -v") return ok("v22.23.3\n");
    if (key.includes("command -v pnpm")) return ok();
    if (key.startsWith("git status --porcelain")) return ok(state.dirty ?? "");
    if (key === "git branch --show-current") return ok("fix/demo\n");
    if (key === "git merge-base HEAD origin/main") return ok("base111\n");
    if (key === "git rev-parse HEAD") return ok(`${state.head}\n`);
    if (key === "git rev-parse --verify -q origin/main")
      return ok(`${state.main ?? "main222"}\n`);
    if (key.startsWith("git rev-parse --git-path"))
      return ok(`.git/${args.at(-1)}\n`);
    if (key.startsWith("git diff")) return ok();
    if (key.startsWith("pnpm -s roadmap done")) return ok();
    for (const [name, res] of Object.entries(state.stages ?? {})) {
      if (key === `pnpm -s ${name}`)
        return { stdout: "", stderr: "", ...res, code: res.code ?? 0 };
    }
    return { code: 1, stdout: "", stderr: `unhandled: ${key}` };
  };
  return { exec, calls };
}

function finalize(root, state, env = {}) {
  const { exec, calls } = hostExec(state);
  const r = run(["finalize", "demo", "--root", root], { cwd: root, exec, env });
  const ran = calls
    .map((c) => c.key)
    .filter((k) => /^pnpm -s (check:integrity|quality:self-check)$/.test(k));
  return { ...r, calls, ran, first: (r.out || r.err).split("\n")[0] };
}

const RERUN =
  "then rerun: pnpm -s agent finalize demo (this stage only: pnpm -s quality:self-check)";

describe("finalize replay: real self-check failures → one actionable line", () => {
  it.each([
    [
      "1-evidence-leftover.txt",
      "evidence: openspec/changes/design-r3-book-cover/tasks.md:7 no test/link/commit evidence;",
    ],
    [
      "2-ratchet-test-file-deleted.txt",
      "gates: [test-file-deleted] test file deleted without companion source: e2e/live-captions.spec.ts (+4 more) (+ failing: evidence)",
    ],
    [
      "3-disables-nocoverage.txt",
      "disables: NoCoverage mutant in /work/photobooks-wt-printer-presets/reports/mutation/mutation.json (+ failing: evidence)",
    ],
    [
      "7-ratchet-agent-rules-over-budget.txt",
      "gates: [agent-rules-over-budget] agentRules.budgets missing entry for .claude/agents/code-scout.md (+ failing: evidence)",
    ],
  ])("%s", (file, cause) => {
    const root = finalizeRoot();
    const r = finalize(root, {
      head: "h1",
      stages: {
        "check:integrity": {},
        "quality:self-check": { code: 1, stdout: readCase(file) },
      },
    });
    expect(r.code).toBe(1);
    expect(r.first.startsWith("FAIL quality:self-check: ")).toBe(true);
    expect(r.first).toContain(cause);
    expect(r.first.endsWith(`— fix, commit, ${RERUN}`)).toBe(true);
    // Detail keeps failing rows only; passing / n.a. rows are noise.
    const detail = r.out.split("\n").slice(1);
    expect(detail.some((l) => /: (pass|n\.a\.)\b/.test(l))).toBe(false);
    expect(detail.at(-1)).toBe(
      "stages: check:integrity 0.0s, quality:self-check fail",
    );
  });

  it("5-delta-sync: the thrown message leads with what to copy and the rerun", () => {
    expect(readCase("5-delta-sync.txt")).not.toMatch(/rerun/);
    const root = finalizeRoot();
    const spec = path.join(root, "openspec", "changes", "demo", "specs", "publish");
    fs.mkdirSync(spec, { recursive: true });
    fs.writeFileSync(
      path.join(spec, "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Guided setup discovery\n\n### Requirement: Resumable guided provisioning\n",
    );
    const main = path.join(root, "openspec", "specs", "publish");
    fs.mkdirSync(main, { recursive: true });
    fs.writeFileSync(
      path.join(main, "spec.md"),
      "# publish\n\n### Requirement: Publish a book\n",
    );
    const r = finalize(root, { head: "h1" });
    expect(r.code).toBe(1);
    expect(r.err.split("\n")[0]).toBe(
      "error: delta-spec sync check failed: 2 requirement(s) not in openspec/specs — copy the ADDED/MODIFIED requirement blocks from openspec/changes/demo/specs/<cap>/spec.md into openspec/specs/<cap>/spec.md (drop REMOVED ones), commit, then rerun: pnpm -s agent finalize demo",
    );
    expect(r.err).toContain(
      "openspec/specs/publish/spec.md missing Requirement: Guided setup discovery",
    );
  });

  it("6-dirty-tree: the thrown message names the paths and the rerun", () => {
    expect(readCase("6-dirty-tree.txt")).not.toMatch(/rerun/);
    const root = finalizeRoot();
    const r = finalize(root, {
      head: "h1",
      dirty: "M openspec/specs/publish/spec.md\n?? openspec/changes/demo/tasks.md",
    });
    expect(r.code).toBe(1);
    expect(r.err.split("\n")[0]).toBe(
      "error: working tree not clean: 2 path(s) (openspec/specs/publish/spec.md, openspec/changes/demo/tasks.md) — commit them, then rerun: pnpm -s agent finalize demo",
    );
  });
});

describe("finalize stage cache (resumable reruns)", () => {
  it("a rerun on the same head skips passed stages; a new head or main reruns all", () => {
    const root = finalizeRoot();
    const failing = {
      "check:integrity": {},
      "quality:self-check": {
        code: 1,
        stdout: readCase("1-evidence-leftover.txt"),
      },
    };
    const first = finalize(root, { head: "h1", stages: failing });
    expect(first.ran).toEqual(["pnpm -s check:integrity", "pnpm -s quality:self-check"]);

    const second = finalize(root, { head: "h1", stages: failing });
    expect(second.ran).toEqual(["pnpm -s quality:self-check"]);
    expect(second.out).toContain(
      "stages: check:integrity cached, quality:self-check fail",
    );

    const passing = { "check:integrity": {}, "quality:self-check": {} };
    const third = finalize(root, { head: "h1", stages: passing });
    expect(third.code).toBe(0);
    expect(third.ran).toEqual(["pnpm -s quality:self-check"]);
    expect(third.out).toMatch(
      /^ok: finalize demo \(check:integrity cached, quality:self-check \d+\.\ds\)$/,
    );

    const same = finalize(root, { head: "h1", stages: passing });
    expect(same.ran).toEqual([]);
    expect(fs.existsSync(path.join(root, ".cache", "agent-green-tree"))).toBe(true);

    expect(finalize(root, { head: "h2", stages: passing }).ran).toHaveLength(2);
    expect(
      finalize(root, { head: "h2", main: "main333", stages: passing }).ran,
    ).toHaveLength(2);
  });

  it("a rewritten local Stryker report invalidates the cache", () => {
    const root = finalizeRoot();
    const passing = { "check:integrity": {}, "quality:self-check": {} };
    finalize(root, { head: "h1", stages: passing });
    const report = path.join(root, "reports", "mutation", "mutation.json");
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, '{"files":{}}\n');
    expect(finalize(root, { head: "h1", stages: passing }).ran).toHaveLength(2);
  });

  it("no HEAD (no commits) runs every stage and writes no cache", () => {
    const root = finalizeRoot();
    const passing = { "check:integrity": {}, "quality:self-check": {} };
    finalize(root, { head: "", stages: passing });
    expect(finalize(root, { head: "", stages: passing }).ran).toHaveLength(2);
    expect(
      fs.existsSync(path.join(root, ".git", "agent-finalize-stages.json")),
    ).toBe(false);
  });
});

describe("finalize stage env and timeout", () => {
  it("stages get the fork-point ratchet base and the real branch (case 2 root cause)", () => {
    const root = finalizeRoot();
    const r = finalize(root, {
      head: "h1",
      stages: { "check:integrity": {}, "quality:self-check": {} },
    });
    const stage = r.calls.find((c) => c.key === "pnpm -s quality:self-check");
    expect(stage.env.GATE_RATCHET_BASE).toBe("base111");
    expect(stage.env.PR_POLICY_BRANCH).toBe("fix/demo");
    expect(stage.timeout).toBe(FINALIZE_STAGE_TIMEOUT_MS);
  });

  it("explicit env wins over the derived ratchet base / branch / timeout", () => {
    const root = finalizeRoot();
    const r = finalize(
      root,
      { head: "h1", stages: { "check:integrity": {}, "quality:self-check": {} } },
      {
        GATE_RATCHET_BASE: "pinned",
        PR_POLICY_BRANCH: "fix/other",
        AGENT_FINALIZE_STAGE_TIMEOUT_MS: "5000",
      },
    );
    const stage = r.calls.find((c) => c.key === "pnpm -s check:integrity");
    expect(stage.env.GATE_RATCHET_BASE).toBe("pinned");
    expect(stage.env.PR_POLICY_BRANCH).toBe("fix/other");
    expect(stage.timeout).toBe(5000);
  });

  it("a hung stage fails as timeout with the rerun line, not a killed tool call", () => {
    const root = finalizeRoot();
    const r = finalize(root, {
      head: "h1",
      stages: {
        "check:integrity": { code: 124, timedOut: true, stderr: "(timed out after 600s)" },
      },
    });
    expect(r.code).toBe(1);
    expect(r.first).toBe(
      "FAIL check:integrity: check:integrity timed out — find the hung step, then rerun: pnpm -s agent finalize demo (this stage only: pnpm -s check:integrity)",
    );
    expect(r.out).toContain("stages: check:integrity timeout");
  });

  it("defaultExec reports a spawn timeout as code 124 + timedOut", () => {
    const r = defaultExec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      timeout: 300,
    });
    expect(r.code).toBe(124);
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toContain("timed out after 0s");
  });
});

describe("finalize own tick evidence (checked before archive)", () => {
  it("fails on the item's own unevidenced tick and keeps the change dir", () => {
    const root = finalizeRoot();
    const change = path.join(root, "openspec", "changes", "demo");
    fs.mkdirSync(change, { recursive: true });
    fs.writeFileSync(path.join(change, ".skip-specs"), "");
    fs.writeFileSync(
      path.join(change, "tasks.md"),
      "- [x] 1.1 vague\n- [x] 1.2 covered (src/a.test.ts)\n- [x] 1.3 vague too\n",
    );
    const r = finalize(root, { head: "h1" });
    expect(r.code).toBe(1);
    expect(r.first).toBe(
      "FAIL evidence: openspec/changes/demo/tasks.md:1 no test/link/commit evidence (+1 more) — name a test file, commit sha or link in each tick, commit, then rerun: pnpm -s agent finalize demo",
    );
    expect(fs.existsSync(change)).toBe(true);
    expect(r.ran).toEqual([]);
  });
});

describe("finish stryker gate: mutation miss line", () => {
  it("leads the block detail with survivors in the diff as file:line", () => {
    const root = finalizeRoot();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { "stryker:diff": "x" } }),
    );
    const report = path.join(root, "reports", "mutation", "mutation.json");
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(
      report,
      JSON.stringify({
        files: {
          "src/a.ts": {
            mutants: [
              { status: "Killed", mutatorName: "X", location: { start: { line: 1 } } },
              {
                status: "Survived",
                mutatorName: "ConditionalExpression",
                location: { start: { line: 3 } },
              },
            ],
          },
          "src/untouched.ts": {
            mutants: [
              { status: "Survived", mutatorName: "Y", location: { start: { line: 9 } } },
            ],
          },
        },
      }),
    );
    const exec = (file, args) => {
      const key = `${file} ${args.join(" ")}`;
      if (key === "git diff --name-only origin/main...HEAD")
        return { code: 0, stdout: "src/a.ts\n", stderr: "" };
      if (key === "git rev-parse HEAD") return { code: 0, stdout: "h1\n", stderr: "" };
      if (key.startsWith("git rev-parse --git-path"))
        return { code: 0, stdout: `.git/${args.at(-1)}\n`, stderr: "" };
      if (key === "pnpm -s stryker:diff")
        return { code: 1, stdout: "score 70 < break 85\n", stderr: "" };
      return { code: 1, stdout: "", stderr: `unhandled: ${key}` };
    };
    const g = finishStrykerGate({ root, cwd: root, env: {}, exec, quiet: true }, "fix/demo");
    expect(g.status).toBe("block");
    expect(g.detail.split("\n")[0]).toBe(
      "Survived src/a.ts:3 ConditionalExpression — add a test that kills it, then rerun: pnpm stryker:diff",
    );
  });
});
