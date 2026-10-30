import { describe, expect, it } from "vitest";
import { resolvePreflightSlug } from "../../src/agent.mjs";

describe("resolvePreflightSlug", () => {
  it("keeps an explicit --slug", () => {
    expect(
      resolvePreflightSlug({
        slug: "a",
        linked: true,
        currentBranch: "feat/b",
      }),
    ).toEqual({ slug: "a", inferred: false });
  });
  it("infers the slug from feat/<slug> in a linked worktree", () => {
    expect(
      resolvePreflightSlug({
        slug: undefined,
        linked: true,
        currentBranch: "feat/kit10-cover\n",
      }),
    ).toEqual({ slug: "kit10-cover", inferred: true });
    expect(
      resolvePreflightSlug({
        slug: undefined,
        linked: true,
        currentBranch: "fix/x-y",
      }).slug,
    ).toBe("x-y");
  });
  it("falls back to roadmap next on main, detached, or the primary checkout", () => {
    expect(
      resolvePreflightSlug({
        slug: undefined,
        linked: true,
        currentBranch: "main",
      }).slug,
    ).toBeNull();
    expect(
      resolvePreflightSlug({ slug: undefined, linked: true, currentBranch: "" })
        .slug,
    ).toBeNull();
    expect(
      resolvePreflightSlug({
        slug: undefined,
        linked: false,
        currentBranch: "feat/z",
      }).slug,
    ).toBeNull();
  });
  it("refuses an unrecognised non-main branch in a linked worktree", () => {
    expect(() =>
      resolvePreflightSlug({
        slug: undefined,
        linked: true,
        currentBranch: "chore/rig-0.2.19",
      }),
    ).toThrow(/refusing to switch branches/);
  });
});
