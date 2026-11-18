// @vitest-environment node
import { EventEmitter } from "node:events";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDesktopCourseBrowser } from "../../../scripts/automation/course-support-browser-desktop.mjs";
import { createCourseBrowserBridge } from "../../../scripts/automation/course-support-browser-bridge.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "desktop-course-browser-"))); roots.push(cwd);
  await mkdir(join(cwd, ".codex-artifacts"));
  const openRequest = join(cwd, ".codex-artifacts", "open.json");
  await writeFile(openRequest, JSON.stringify({ action: "open", assignmentRef: "owned-assignment", token: "private-token", revision: 7, source: "booking", selectedCheckout: cwd }));
  return { cwd, openRequest, selectedCheckout: cwd, environment: { CODEX_THREAD_ID: "native-original-owner" } };
}

describe("Desktop command transport for owned interactive research", () => {
  it("uses the original owned source process for screenshots, controls and final revision without a Desktop dynamic tool", async () => {
    const options = await fixture();
    let providerDone: Promise<void> | undefined;
    const spawnProcess = vi.fn((_node: string, args: string[], settings: { env: Record<string, string>; shell: boolean; windowsHide: boolean }) => {
      expect(settings).toMatchObject({ env: { CODEX_THREAD_ID: "native-original-owner" }, shell: false, windowsHide: true });
      expect(args.slice(args.indexOf("--script") + 1, args.indexOf("--script") + 3)).toEqual(["automation:simulator-support", "--"]);
      const channel = args[args.indexOf("--interactive-channel") + 1];
      expect(args).toContain("owned-assignment"); expect(args).toContain("private-token");
      const child = new EventEmitter();
      providerDone = (async () => {
        const publish = async (sequence: number) => {
          const path = join(channel, `response-${sequence}.json`);
          await writeFile(`${path}.tmp`, JSON.stringify({ phase: "open", sequence, screenshot: "AAAA", controls: [{ id: `date-${sequence}`, kind: "date" }] }));
          await rename(`${path}.tmp`, path);
        };
        await publish(0);
        for (const [sequence, expected] of [[1, { action: "fill", target: "date-0", text: "2026-11-20" }], [2, { action: "finish" }]] as const) {
          const path = join(channel, `request-${sequence}.json`);
          for (let attempt = 0; attempt < 300; attempt++) {
            try { await lstat(path); break; } catch { await new Promise(done => setTimeout(done, 10)); }
          }
          expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
          if (sequence === 1) await publish(1);
        }
        await writeFile(join(channel, "production-stdout.txt"), JSON.stringify({ acquired: true, value: { revision: 8 } }));
        await writeFile(join(channel, "production-stderr.txt"), JSON.stringify({ workerProductionOutput: { payloadAvailable: true } }));
        child.emit("close", 0);
      })();
      return child;
    });
    const outputs: Array<{ sequence: number; content: Array<{ type: string; path?: string; text?: string }>; closed: boolean; nextRequestPath: string | null }> = [];
    const result = await runDesktopCourseBrowser(options, {
      createBridge: (input: Parameters<typeof createCourseBrowserBridge>[0]) => createCourseBrowserBridge({ ...input, spawnProcess }),
      publish: async (value: typeof outputs[number]) => {
        outputs.push(value);
        if (!value.closed) {
          const image = value.content.find(item => item.type === "imagePath")!;
          expect(await readFile(image.path!)).toEqual(Buffer.from("AAAA", "base64"));
          const request = value.sequence === 0 ? { action: "fill", target: "date-0", text: "2026-11-20" } : { action: "finish" };
          await writeFile(`${value.nextRequestPath}.tmp`, JSON.stringify(request));
          await rename(`${value.nextRequestPath}.tmp`, value.nextRequestPath!);
        }
      },
    });
    await providerDone;
    expect(result).toEqual({ outcome: "completed", exitCode: 0 });
    expect(outputs.map(row => row.sequence)).toEqual([0, 1, 2]);
    expect(outputs[2].closed).toBe(true);
    expect(JSON.parse(outputs[2].content[0].text!).results[0]).toEqual({ acquired: true, value: { revision: 8 } });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(JSON.stringify(outputs)).not.toContain("private-token");
    expect(JSON.stringify(outputs)).not.toContain("data:image");
  });

  it.each(["identity", "outside", "hardlink", "symlink", "unknown-key", "wrong-binding", "oversize"])("rejects %s before opening a source", async failure => {
    const options = await fixture();
    if (failure === "identity") options.environment.CODEX_THREAD_ID = "";
    if (failure === "outside") { const outside = join(options.cwd, "outside.json"); await rename(options.openRequest, outside); options.openRequest = outside; }
    if (failure === "hardlink") await link(options.openRequest, join(options.cwd, "alias.json"));
    if (failure === "symlink") {
      const target = join(options.cwd, "shared"); await mkdir(target);
      await rename(options.openRequest, join(target, "open.json"));
      const redirect = join(options.cwd, ".codex-artifacts", "redirect");
      await symlink(target, redirect, process.platform === "win32" ? "junction" : "dir");
      options.openRequest = join(redirect, "open.json");
    }
    if (failure === "unknown-key") await writeFile(options.openRequest, JSON.stringify({ action: "open", url: "https://caller.invalid/" }));
    if (failure === "wrong-binding") options.selectedCheckout = "another-checkout";
    if (failure === "oversize") await writeFile(options.openRequest, " ".repeat(16_385));
    const createBridge = vi.fn();
    await expect(runDesktopCourseBrowser(options, { createBridge })).rejects.toThrow(/DESKTOP_BROWSER_/);
    expect(createBridge).not.toHaveBeenCalled();
  });

  it.each(["open", "token", "url", "identity"])("never reopens or broadens the source for a subsequent %s request", async failure => {
    const options = await fixture();
    const call = vi.fn(async () => ({ success: true, contentItems: [] })), close = vi.fn();
    await expect(runDesktopCourseBrowser(options, { createBridge: () => ({ call, close }), publish: async ({ nextRequestPath }: { nextRequestPath: string }) => {
      if (failure === "identity") options.environment.CODEX_THREAD_ID = "replacement-owner";
      const request = failure === "open" ? { action: "open" } : failure === "token" ? { action: "observe", token: "replacement-token" }
        : failure === "url" ? { action: "observe", url: "https://caller.invalid" } : { action: "observe" };
      await writeFile(nextRequestPath, JSON.stringify(request));
    } })).rejects.toThrow(/DESKTOP_BROWSER_/);
    expect(call).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it("closes the original source once when the owning Desktop turn stops responding", async () => {
    const options = await fixture();
    let elapsed = 0;
    const call = vi.fn(async () => ({ success: true, contentItems: [] })), close = vi.fn();
    await expect(runDesktopCourseBrowser(options, { createBridge: () => ({ call, close }), now: () => elapsed,
      pause: async () => { elapsed += 60_000; }, publish: vi.fn() })).rejects.toThrow("DESKTOP_BROWSER_DEADLINE");
    expect(elapsed).toBe(6 * 60_000);
    expect(call).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it("retains a failed original result without starting another source", async () => {
    const options = await fixture();
    const call = vi.fn(async () => ({ success: false, contentItems: [{ type: "inputText", text: '{"error":"BROWSER_FAILED"}' }] })), close = vi.fn();
    expect(await runDesktopCourseBrowser(options, { createBridge: () => ({ call, close }), publish: vi.fn() }))
      .toEqual({ outcome: "browser_failed", exitCode: 2 });
    expect(call).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
});
