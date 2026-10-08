// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKER_PERMISSION_PROFILE,
  WORKER_TURN_TIMEOUT_MS,
  assertFullAccessAcknowledgement,
  assertOwnedWorkerCheckout,
  assertUnusedWorkerThread,
  buildWorkerFirstTurnPrompt,
  courseSupportWorkerAppServerEnvironment,
  createWorkerAppServer,
  hasNativeIdentityProof,
  isApprovalRequest,
  prepareCourseSupportWorker,
  privateWrite,
  readWorkerCliVersion,
  readWorkerLauncherArguments,
  runPreparedCourseSupportWorker,
} from "../../../scripts/automation/course-support-worker-launcher.mjs";

const THREAD = "11111111-2222-7333-8444-555555555555";
const TURN = "first-owned-turn";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Message = { method: string; params: Record<string, unknown>; id?: number };
type ClientOptions = { onMessage: (message: Message) => void; onFailure: (error: Error) => void };

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "course-worker-launcher-"));
  roots.push(cwd);
  const cliPath = join(cwd, "codex.exe");
  const receiptPath = join(cwd, "launch.private.json");
  const promptPath = join(cwd, "authorized-private-prompt.txt");
  writeFileSync(cliPath, "fake, never executed");
  writeFileSync(promptPath, "Read only the owned assignment; bootstrap before claiming; never send email.");
  const checkout = { cwd, branch: "automation/course-support-test-worker", baseSha: "a".repeat(40) };
  const thread = {
    id: THREAD, cwd, ephemeral: false, historyMode: "legacy", status: { type: "idle" }, turns: [], source: "vscode",
  };
  const ack = { cwd, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: WORKER_PERMISSION_PROFILE }, thread };
  const inspectCheckout = vi.fn(() => checkout);
  const inspectCli = vi.fn(() => "codex-cli 0.160.0");
  const options = { cliPath, cwd, receiptPath, promptPath, inspectCheckout, inspectCli, nodePath: process.execPath };
  const readReceipt = () => JSON.parse(readFileSync(receiptPath, "utf8"));
  return { cwd, thread, ack, options, readReceipt };
}

function identity(threadId = THREAD, exitCode = 0) {
  return {
    method: "item/completed", params: { threadId, turnId: TURN, item: {
      type: "commandExecution", exitCode,
      aggregatedOutput: JSON.stringify({ courseWorkerNativeIdentity: { present: true, matchesExpected: true } }),
    } },
  };
}

function fakeServer(f: ReturnType<typeof fixture>, overrides: Record<string, (params: Record<string, unknown>, hooks: ClientOptions) => unknown> = {}) {
  let hooks: ClientOptions;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (overrides[method]) return overrides[method](params, hooks);
    if (method === "permissionProfile/list") return { data: [{ id: WORKER_PERMISSION_PROFILE, allowed: true }] };
    if (method === "thread/start" || method === "thread/resume") return f.ack;
    if (method === "thread/read") return { thread: f.thread };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (method === "turn/start") {
      hooks.onMessage({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
      queueMicrotask(() => {
        hooks.onMessage(identity());
        hooks.onMessage({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } });
      });
      return { turn: { id: TURN } };
    }
    return {};
  });
  const client = { request, notify: vi.fn(), close: vi.fn(async () => {}), pid: 12345 };
  const clientFactory = vi.fn((options: ClientOptions) => { hooks = options; return client; });
  return { clientFactory, client, request };
}

describe("course worker preparation contract", () => {
  it("creates only one idle persistent truthful native thread after allowed-profile acknowledgement", async () => {
    const f = fixture();
    const server = fakeServer(f);
    await expect(prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory, title: "Course investigation" }))
      .resolves.toMatchObject({ outcome: "prepared", threadId: THREAD });
    expect(server.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "permissionProfile/list", "thread/start", "thread/name/set"]);
    expect(server.request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toEqual({
      cwd: f.cwd, ephemeral: false, historyMode: "legacy", approvalPolicy: "never", permissions: WORKER_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: [f.cwd], threadSource: "agent_created_thread",
    });
    expect(f.readReceipt()).toMatchObject({ status: "PREPARED", threadId: THREAD, historyMode: "legacy", approvalPolicy: "never", nativeIdentityVerified: false, serverPid: 12345 });
    expect(server.client.close).toHaveBeenCalledOnce();
  });

  it("records the qualified 0.160.1 CLI while preserving permissions and an idle first turn", async () => {
    const f = fixture();
    const server = fakeServer(f);
    await prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory,
      inspectCli: (path: string) => readWorkerCliVersion(path, () => "codex-cli 0.160.1\n") });
    expect(f.readReceipt()).toMatchObject({ cliVersion: "codex-cli 0.160.1", status: "PREPARED",
      approvalPolicy: "never", activePermissionProfile: { id: WORKER_PERMISSION_PROFILE }, nativeIdentityVerified: false });
    expect(server.request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      approvalPolicy: "never", permissions: WORKER_PERMISSION_PROFILE, ephemeral: false });
    expect(server.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("rejects an unqualified CLI before starting any native server or chat", async () => {
    const f = fixture();
    const server = fakeServer(f);
    await expect(prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory,
      inspectCli: (path: string) => readWorkerCliVersion(path, () => "codex-cli 0.160.2") }))
      .rejects.toThrow("UNVERIFIED_CODEX_CLI_VERSION");
    expect(server.clientFactory).not.toHaveBeenCalled();
    expect(server.request).not.toHaveBeenCalled();
  });

  it("stops before creation when full access is not allowed", async () => {
    const f = fixture();
    const server = fakeServer(f, { "permissionProfile/list": () => ({ data: [{ id: WORKER_PERMISSION_PROFILE, allowed: false }] }) });
    await expect(prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("FULL_ACCESS_PROFILE_NOT_ALLOWED");
    expect(server.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    expect(f.readReceipt()).toMatchObject({ status: "FAILED_BEFORE_CREATION", nativeCreationPossible: false, threadId: null });
  });

  it("retains a created native UUID if its returned permission profile is weaker", async () => {
    const f = fixture();
    const server = fakeServer(f, { "thread/start": () => ({ ...f.ack, approvalPolicy: "on-request" }) });
    await expect(prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("FULL_ACCESS_NOT_ACKNOWLEDGED");
    expect(f.readReceipt()).toMatchObject({ status: "CREATION_UNKNOWN", threadId: THREAD, nativeCreationPossible: true });
    expect(server.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("preserves an explicit unsupported cold paginated attempt without falling back or launching a turn", async () => {
    const f = fixture();
    f.thread.historyMode = "paginated";
    await prepareCourseSupportWorker({ ...f.options, historyMode: "paginated", clientFactory: fakeServer(f).clientFactory });
    const server = fakeServer(f, { "thread/turns/list": () => {
      throw Object.assign(new Error("invalid paginated history lineage"), { code: "APP_SERVER_RPC_REJECTED", rpcCode: -32600 });
    } });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("invalid paginated history lineage");
    expect(f.readReceipt()).toMatchObject({ status: "STOPPED", historyMode: "paginated", threadId: THREAD, approvalRequests: 0 });
    expect(server.request.mock.calls.some(([method]) => method === "thread/start" || method === "thread/resume" || method === "turn/start")).toBe(false);
  });

  it("records an ambiguous creation and never retries or overwrites that receipt", async () => {
    const f = fixture();
    const server = fakeServer(f, { "thread/start": () => { throw new Error("ambiguous transport"); } });
    await expect(prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("ambiguous transport");
    expect(f.readReceipt()).toMatchObject({ status: "CREATION_UNKNOWN", threadId: null, nativeCreationPossible: true });
    await expect(prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow();
    expect(server.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(server.clientFactory).toHaveBeenCalledOnce();
  });

  it("rejects approval requests while preparing without starting a turn", async () => {
    const f = fixture();
    const server = fakeServer(f, { "thread/start": (_params, hooks) => {
      hooks.onMessage({ method: "item/commandExecution/requestApproval", id: 77, params: {} });
      return f.ack;
    } });
    await expect(prepareCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("UNEXPECTED_APPROVAL_REQUEST");
    expect(f.readReceipt().approvalRequests).toBe(1);
    expect(server.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });
});

describe("one first turn after external binding", () => {
  async function prepared(overrides: Parameters<typeof fakeServer>[1] = {}) {
    const f = fixture();
    await prepareCourseSupportWorker({ ...f.options, clientFactory: fakeServer(f).clientFactory });
    return { f, server: fakeServer(f, overrides) };
  }

  it("checks empty durable history, re-acknowledges full access, then records native identity and completion", async () => {
    const { f, server } = await prepared();
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).resolves.toEqual({
      outcome: "completed", nativeIdentityVerified: true, approvalRequests: 0,
    });
    expect(server.request.mock.calls.map(([method]) => method)).toEqual([
      "initialize", "permissionProfile/list", "thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list", "turn/start",
    ]);
    const start = server.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(start).toMatchObject({ threadId: THREAD, cwd: f.cwd, approvalPolicy: "never", permissions: WORKER_PERMISSION_PROFILE });
    expect(start).not.toHaveProperty("sandboxPolicy");
    expect(start).not.toHaveProperty("model");
    expect(f.readReceipt()).toMatchObject({ status: "COMPLETED", turnId: TURN, nativeIdentityVerified: true });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("UNUSED_PREPARED_RECEIPT_REQUIRED");
    expect(server.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("rejects a previous turn hidden by metadata-only reads before resume or start", async () => {
    const { f, server } = await prepared({ "thread/turns/list": () => ({ data: [{ id: "prior-user-turn" }] }) });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("PREPARED_THREAD_IS_NOT_UNUSED");
    expect(server.request.mock.calls.some(([method]) => method === "thread/resume" || method === "turn/start")).toBe(false);
    expect(f.readReceipt().status).toBe("STOPPED");
  });

  it("rejects a profile downgrade on resume and never starts", async () => {
    const { f, server } = await prepared({ "thread/resume": () => ({ ...f.ack, activePermissionProfile: { id: ":workspace" } }) });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("FULL_ACCESS_NOT_ACKNOWLEDGED");
    expect(server.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("interrupts its own first turn on any approval request without approving", async () => {
    const { f, server } = await prepared({ "turn/start": (_params, hooks) => {
      hooks.onMessage({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
      hooks.onMessage({ method: "item/fileChange/requestApproval", id: 7, params: { threadId: THREAD } });
      return { turn: { id: TURN } };
    } });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("UNEXPECTED_APPROVAL_REQUEST");
    expect(server.request.mock.calls.at(-1)).toEqual(["turn/interrupt", { threadId: THREAD, turnId: TURN }]);
    expect(f.readReceipt()).toMatchObject({ status: "STOPPED", approvalRequests: 1, failureCode: "UNEXPECTED_APPROVAL_REQUEST" });
  });

  it("cannot use another native task's proof to pass completion", async () => {
    const { f, server } = await prepared({ "turn/start": (_params, hooks) => {
      hooks.onMessage({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
      hooks.onMessage(identity("99999999-2222-7333-8444-555555555555"));
      hooks.onMessage({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } });
      return { turn: { id: TURN } };
    } });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("NATIVE_THREAD_IDENTITY_NOT_PROVED");
    expect(f.readReceipt().nativeIdentityVerified).toBe(false);
  });

  it("wakes immediately on server failure instead of waiting for the episode timeout", async () => {
    const { f, server } = await prepared({ "turn/start": (_params, hooks) => {
      hooks.onMessage({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
      hooks.onFailure(Object.assign(new Error("APP_SERVER_CLOSED"), { code: "APP_SERVER_CLOSED" }));
      return { turn: { id: TURN } };
    } });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory })).rejects.toThrow("APP_SERVER_CLOSED");
    expect(f.readReceipt()).toMatchObject({ status: "STOPPED", failureCode: "APP_SERVER_CLOSED" });
  });

  it("bounds a silent first turn and keeps its receipt non-replayable", async () => {
    const { f, server } = await prepared({ "turn/start": (_params, hooks) => {
      hooks.onMessage({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
      return { turn: { id: TURN } };
    } });
    await expect(runPreparedCourseSupportWorker({ ...f.options, clientFactory: server.clientFactory, turnTimeoutMs: 10 })).rejects.toThrow("WORKER_TURN_TIMEOUT");
    expect(server.request.mock.calls.at(-1)?.[0]).toBe("turn/interrupt");
    expect(f.readReceipt().status).toBe("STOPPED");
  });
});

describe("worker environment and acknowledgement guards", () => {
  it("keeps Codex auth-file locations while stripping inherited product keys and native identity", () => {
    const runtime = { status: "available", nodePath: "C:\\Program Files\\nodejs\\node.exe", npmCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" };
    const cwd = resolve("private-worker");
    const environment = courseSupportWorkerAppServerEnvironment(cwd, {
      PATH: "roaming-npm", CODEX_HOME: "codex-auth-home", HOME: "user-auth-home", CODEX_THREAD_ID: THREAD,
      DATABASE_URL: "private-db", RESEND_API_KEY: "private-resend", CLERK_SECRET_KEY: "private-clerk", AUTOMATION_API_KEY: "private-automation", npm_config_prefix: "shared-prefix",
    }, runtime);
    expect(environment.CODEX_HOME).toBe("codex-auth-home");
    expect(environment.HOME).toBe("user-auth-home");
    expect(environment.PATH).toBe("C:\\Program Files\\nodejs;roaming-npm");
    expect(environment.npm_config_prefix).toBe(resolve(cwd, ".codex-artifacts", "npm-prefix"));
    expect(environment.npm_config_cache).toBe(resolve(cwd, ".codex-artifacts", "npm-cache"));
    for (const key of ["CODEX_THREAD_ID", "DATABASE_URL", "RESEND_API_KEY", "CLERK_SECRET_KEY", "AUTOMATION_API_KEY"]) expect(environment[key]).toBeUndefined();
  });

  it("requires every permission acknowledgement and matching cwd", () => {
    const f = fixture();
    expect(assertFullAccessAcknowledgement(f.ack, f.cwd)).toBe(f.ack);
    for (const result of [{ ...f.ack, approvalPolicy: "on-request" }, { ...f.ack, sandbox: { type: "workspaceWrite" } },
      { ...f.ack, activePermissionProfile: null }, { ...f.ack, cwd: join(f.cwd, "other") }]) {
      expect(() => assertFullAccessAcknowledgement(result, f.cwd)).toThrow("FULL_ACCESS_NOT_ACKNOWLEDGED");
    }
    expect(() => assertUnusedWorkerThread({ ...f.thread, ephemeral: true }, THREAD, "paginated")).toThrow();
    expect(() => assertUnusedWorkerThread({ ...f.thread, turns: [{}] }, THREAD, "paginated")).toThrow();
  });

  it("inspects only a clean linked named task branch at origin/main without Git optional locks", () => {
    const f = fixture();
    const git = vi.fn((_binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      expect(options.env.GIT_OPTIONAL_LOCKS).toBe("0");
      const values: Record<string, string> = {
        "rev-parse --show-toplevel": f.cwd, "branch --show-current": "automation/course-support-test-worker", "rev-parse HEAD": "a".repeat(40),
        "rev-parse origin/main": "a".repeat(40), "rev-parse --git-common-dir": tmpdir(), "rev-parse --absolute-git-dir": f.cwd, "status --porcelain": "",
      };
      return values[args.join(" ")];
    });
    expect(assertOwnedWorkerCheckout(f.cwd, f.cwd, git).branch).toBe("automation/course-support-test-worker");
    expect(git.mock.calls.every(([, args]) => ["rev-parse", "branch", "status"].includes(args[0]))).toBe(true);
  });

  it("resolves relative Git common paths without unsupported path-format flags", () => {
    const f = fixture();
    const git = vi.fn((_binary: string, args: string[]) => {
      const values: Record<string, string> = {
        "rev-parse --show-toplevel": f.cwd, "branch --show-current": "automation/course-support-test-worker", "rev-parse HEAD": "a".repeat(40),
        "rev-parse origin/main": "a".repeat(40), "rev-parse --git-common-dir": "..", "rev-parse --absolute-git-dir": f.cwd, "status --porcelain": "",
      };
      return values[args.join(" ")] ?? "--path-format=absolute\n..";
    });
    expect(assertOwnedWorkerCheckout(f.cwd, f.cwd, git).cwd).toBe(f.cwd);
    expect(git.mock.calls.some(([, args]) => args.some((value) => value.startsWith("--path-format")))).toBe(false);
  });

  it.each(["codex-cli 0.160.0", "codex-cli 0.160.1"])("pins qualified %s and does not substitute PATH", (version) => {
    const f = fixture();
    const execute = vi.fn(() => `${version}\n`);
    expect(readWorkerCliVersion(f.options.cliPath, execute)).toBe(version);
    expect(execute.mock.calls[0]?.[0]).toBe(f.options.cliPath);
    expect(() => readWorkerCliVersion("codex.exe", execute)).toThrow("ABSOLUTE_FILE_REQUIRED");
  });

  it.each(["codex-cli 0.145.0", "codex-cli 0.160.2", "codex-cli 0.160.10", "codex-cli 0.161.0", "codex-cli 0.160.1-dev"])(
    "rejects unqualified exact CLI output %s", (version) => {
      const f = fixture();
      expect(() => readWorkerCliVersion(f.options.cliPath, () => version)).toThrow("UNVERIFIED_CODEX_CLI_VERSION");
    });

  it("requires a native identity read and never assigns CODEX_THREAD_ID", () => {
    const prompt = buildWorkerFirstTurnPrompt("authorized work", THREAD, process.execPath);
    expect(prompt).toContain("const actual=process.env.CODEX_THREAD_ID");
    expect(prompt).toContain("actual===expected");
    expect(prompt).not.toContain("process.env.CODEX_THREAD_ID=");
    expect(prompt).toContain("Do not send email");
    expect(hasNativeIdentityProof(identity())).toBe(true);
    expect(hasNativeIdentityProof(identity(THREAD, 76))).toBe(false);
    expect(hasNativeIdentityProof({ method: "item/completed", params: { item: { type: "agentMessage", text: "identity verified" } } })).toBeNull();
  });

  it("rejects unsupported or duplicate command-line options rather than silently ignoring them", () => {
    expect(readWorkerLauncherArguments(["prepare", "--codex", "cli", "--cwd", "cwd", "--receipt", "receipt"])).toMatchObject({ command: "prepare" });
    expect(() => readWorkerLauncherArguments(["run", "--receipt", "r", "--prompt-file", "p", "--codex", "ignored"])).toThrow("INVALID_LAUNCHER_ARGUMENTS");
    expect(() => readWorkerLauncherArguments(["run", "--receipt", "r", "--receipt", "r", "--prompt-file", "p"])).toThrow("INVALID_LAUNCHER_ARGUMENTS");
    expect(() => readWorkerLauncherArguments(["run", "--receipt", "r"])).toThrow("REQUIRED_LAUNCHER_ARGUMENT_MISSING");
  });

  it("allows a complete ordinary episode while keeping a shorter diagnostic timeout explicit and bounded", () => {
    expect(WORKER_TURN_TIMEOUT_MS).toBe(24 * 60 * 60_000);
    expect(readWorkerLauncherArguments(["run", "--receipt", "r", "--prompt-file", "p", "--turn-timeout-ms", "100"]).turnTimeoutMs).toBe(100);
    for (const invalid of ["-1", "Infinity", "NaN", String(WORKER_TURN_TIMEOUT_MS + 1)]) {
      expect(() => readWorkerLauncherArguments(["run", "--receipt", "r", "--prompt-file", "p", "--turn-timeout-ms", invalid])).toThrow("INVALID_FIRST_TURN_LIMITS");
    }
  });
});

describe("bounded app-server transport", () => {
  function transport(options: { timeoutMs?: number; onMessage?: (message: Message) => void } = {}) {
    const f = fixture();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 23456, kill: vi.fn() });
    child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
    const spawnProcess = vi.fn(() => child);
    const onMessage = vi.fn();
    const onFailure = vi.fn();
    const client = createWorkerAppServer({ cliPath: f.options.cliPath, cwd: f.cwd,
      eventPath: join(f.cwd, "events.private.jsonl"), stderrPath: join(f.cwd, "stderr.private.log"),
      spawnProcess, onMessage, onFailure, environment: { HOME: "auth-home" }, ...options });
    return { client, child, spawnProcess, onMessage, onFailure };
  }

  it("uses the explicit CLI in a hidden process and correlates response IDs", async () => {
    const t = transport();
    const requested = t.client.request("permissionProfile/list", { cwd: "private" });
    t.child.stdout.write(`${JSON.stringify({ id: 999, result: { ignored: true } })}\n`);
    t.child.stdout.write(`${JSON.stringify({ id: 1, result: { data: [] } })}\n`);
    await expect(requested).resolves.toEqual({ data: [] });
    expect(t.spawnProcess.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, shell: false, env: { HOME: "auth-home" } });
    await t.client.close();
  });

  it("never answers an approval request and rejects the pending RPC immediately", async () => {
    const t = transport();
    const writes: string[] = [];
    t.child.stdin.on("data", (chunk) => writes.push(String(chunk)));
    const requested = t.client.request("turn/start", {});
    t.child.stdout.write(`${JSON.stringify({ id: 7, method: "item/commandExecution/requestApproval", params: {} })}\n`);
    await expect(requested).rejects.toThrow("UNEXPECTED_APPROVAL_REQUEST");
    expect(writes).toHaveLength(1);
    expect(t.onFailure).toHaveBeenCalled();
    expect(isApprovalRequest({ method: "mcpServer/elicitation/request" })).toBe(true);
    await t.client.close();
  });

  it("bounds RPC timeout and reports invalid wire messages or process exits", async () => {
    const t = transport({ timeoutMs: 5 });
    await expect(t.client.request("initialize", {})).rejects.toThrow("APP_SERVER_RPC_TIMEOUT");
    const requested = t.client.request("thread/read", {});
    t.child.stdout.write("null\n");
    await expect(requested).rejects.toThrow("INVALID_APP_SERVER_MESSAGE");
    expect(t.onFailure).toHaveBeenCalled();
    await t.client.close();
    const closed = transport();
    const pending = closed.client.request("initialize", {});
    closed.child.emit("close", 1);
    await expect(pending).rejects.toThrow("APP_SERVER_CLOSED");
    await closed.client.close();
  });

  it("does not label a valid event with callback I/O failure as malformed wire", async () => {
    const onMessage = vi.fn(() => { throw Object.assign(new Error("receipt locked"), { code: "WORKER_RECEIPT_WRITE_FAILED", causeCode: "EPERM" }); });
    const t = transport({ onMessage });
    const requested = t.client.request("thread/read", {});
    t.child.stdout.write(`${JSON.stringify({ id: 1, result: { thread: null } })}\n`);
    await expect(requested).rejects.toThrow("receipt locked");
    expect(t.onFailure.mock.calls[0][0]).toMatchObject({ code: "WORKER_RECEIPT_WRITE_FAILED", causeCode: "EPERM" });
    expect(onMessage).toHaveBeenCalledOnce();
    await t.client.close();
  });

  it("classifies unrelated event handler failures separately from malformed wire", async () => {
    const t = transport({ onMessage: () => { throw new Error("callback failed"); } });
    const requested = t.client.request("thread/read", {});
    t.child.stdout.write(`${JSON.stringify({ id: 1, result: { thread: null } })}\n`);
    await expect(requested).rejects.toThrow("APP_SERVER_EVENT_HANDLER_FAILED");
    await t.client.close();
  });
});

describe("private receipt replacement", () => {
  it("retries bounded transient Windows rename contention and keeps an atomic receipt", () => {
    const f = fixture();
    const path = join(f.cwd, "receipt.json");
    writeFileSync(path, "old");
    let attempts = 0;
    const sleep = vi.fn();
    privateWrite(path, { status: "RUNNING" }, false, { sleep, rename(from: string, to: string) {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("reader lock"), { code: "EPERM" });
      renameSync(from, to);
    } });
    expect(attempts).toBe(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ status: "RUNNING" });
    expect(readdirSync(f.cwd).filter(name => name.includes(".tmp"))).toEqual([]);
  });

  it("stops after finite contention and preserves the prior receipt", () => {
    const f = fixture();
    const path = join(f.cwd, "receipt.json");
    writeFileSync(path, "old");
    let attempts = 0;
    expect(() => privateWrite(path, { status: "RUNNING" }, false, { sleep: () => {}, rename() {
      attempts += 1;
      throw Object.assign(new Error("reader lock"), { code: "EPERM" });
    } })).toThrow("reader lock");
    expect(attempts).toBe(4);
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readdirSync(f.cwd).filter(name => name.includes(".tmp"))).toEqual([]);
  });
});
