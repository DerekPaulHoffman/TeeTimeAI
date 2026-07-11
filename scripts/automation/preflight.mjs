import { execFileSync } from "node:child_process";

import { getCheckoutMode, getPushRef } from "./preflight-git.mjs";

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function result(payload) {
  console.warn(JSON.stringify(payload, null, 2));
  process.exitCode = payload.outcome === "ok" ? 0 : 1;
}

function getAheadBehind() {
  const [aheadText, behindText] = git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]).split(/\s+/);
  return {
    ahead: Number(aheadText),
    behind: Number(behindText)
  };
}

function getDirtyPaths() {
  return git(["status", "--porcelain"])
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function main() {
  const cwd = process.cwd();
  const startingSha = git(["rev-parse", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

  git(["fetch", "origin"]);

  const dirtyPaths = getDirtyPaths();
  if (dirtyPaths.length > 0) {
    const { ahead, behind } = getAheadBehind();
    result({
      outcome: "blocked_dirty_worktree",
      cwd,
      branch,
      startingSha,
      ahead,
      behind,
      dirtyPaths,
      message: "Working tree is dirty before the automation run; clear these paths or use a fresh automation worktree."
    });
    return;
  }

  const checkoutMode = getCheckoutMode(branch);
  if (!checkoutMode) {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      startingSha,
      message: "Automation must run from main or a clean detached Codex worktree."
    });
    return;
  }

  const pushCommand = `git push origin ${getPushRef(checkoutMode)}`;
  const initialCounts = getAheadBehind();

  if (initialCounts.ahead > 0 && initialCounts.behind > 0) {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      checkoutMode,
      pushCommand,
      startingSha,
      ...initialCounts,
      message: "Checked-out HEAD diverged from origin/main; resolve manually before running automation."
    });
    return;
  }

  if (initialCounts.ahead > 0) {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      checkoutMode,
      pushCommand,
      startingSha,
      ...initialCounts,
      message: "Checked-out HEAD is ahead of origin/main; automation will not push or rewrite unexplained commits."
    });
    return;
  }

  if (initialCounts.behind > 0) {
    git(["merge", "--ff-only", "origin/main"]);
  }

  const finalCounts = getAheadBehind();
  const finalSha = git(["rev-parse", "HEAD"]);

  if (finalCounts.ahead !== 0 || finalCounts.behind !== 0) {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      checkoutMode,
      pushCommand,
      startingSha,
      finalSha,
      ...finalCounts,
      message: "Checked-out HEAD and origin/main are not synchronized after preflight."
    });
    return;
  }

  result({
    outcome: "ok",
    cwd,
    branch,
    checkoutMode,
    pushCommand,
    startingSha,
    finalSha,
    ahead: 0,
    behind: 0,
    message:
      checkoutMode === "detached"
        ? "Automation preflight passed; detached HEAD is clean and synchronized with origin/main."
        : "Automation preflight passed; main is clean and synchronized with origin/main."
  });
}

try {
  main();
} catch (error) {
  result({
    outcome: "blocked_git",
    cwd: process.cwd(),
    message: error instanceof Error ? error.message : String(error)
  });
}
