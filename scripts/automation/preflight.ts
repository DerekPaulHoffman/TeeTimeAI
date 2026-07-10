import { execFileSync } from "node:child_process";

type Outcome = "ok" | "blocked_dirty_worktree" | "blocked_git";

type PreflightResult = {
  outcome: Outcome;
  cwd: string;
  branch?: string;
  startingSha?: string;
  finalSha?: string;
  ahead?: number;
  behind?: number;
  dirtyPaths?: string[];
  message: string;
};

function git(args: string[]) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function result(payload: PreflightResult) {
  console.warn(JSON.stringify(payload, null, 2));
  process.exitCode = payload.outcome === "ok" ? 0 : 1;
}

function getAheadBehind() {
  const [aheadText, behindText] = git(["rev-list", "--left-right", "--count", "main...origin/main"]).split(/\s+/);
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

  if (branch !== "main") {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      startingSha,
      message: "Automation must run from the main branch."
    });
    return;
  }

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
      message: "Working tree is dirty before the automation run; clear these paths or use the dedicated automation checkout."
    });
    return;
  }

  const initialCounts = getAheadBehind();
  if (initialCounts.ahead > 0 && initialCounts.behind > 0) {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      startingSha,
      ...initialCounts,
      message: "Local main diverged from origin/main; resolve manually before running automation."
    });
    return;
  }

  if (initialCounts.ahead > 0) {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      startingSha,
      ...initialCounts,
      message: "Local main is ahead of origin/main; automation will not push or rewrite unexplained commits."
    });
    return;
  }

  if (initialCounts.behind > 0) {
    git(["pull", "--ff-only"]);
  }

  const finalCounts = getAheadBehind();
  const finalSha = git(["rev-parse", "HEAD"]);

  if (finalCounts.ahead !== 0 || finalCounts.behind !== 0) {
    result({
      outcome: "blocked_git",
      cwd,
      branch,
      startingSha,
      finalSha,
      ...finalCounts,
      message: "main and origin/main are not synchronized after preflight."
    });
    return;
  }

  result({
    outcome: "ok",
    cwd,
    branch,
    startingSha,
    finalSha,
    ahead: 0,
    behind: 0,
    message: "Automation preflight passed; main is clean and synchronized with origin/main."
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
