// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCourseBrowserBridge, courseBrowserTool } from "../../../scripts/automation/course-support-browser-bridge.mjs";

describe("native owned browser bridge", () => {
  it("registers a function tool and refuses calls before native identity is verified", async () => {
    const spawnProcess = vi.fn();
    const bridge = createCourseBrowserBridge({ cwd: tmpdir(), threadId: "native", nativeIdentityVerified: () => false, spawnProcess });
    expect(courseBrowserTool).toMatchObject({ type: "function", name: "course_research_browser" });
    expect((await bridge.call({ action: "open" })).success).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("carries screenshots and final original claim revision through the private process channel", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "owned-browser-bridge-"));
    let finished: Promise<void> | undefined;
    const spawnProcess = vi.fn((_node: string, args: string[], options: { shell: boolean; windowsHide: boolean; env: Record<string, string> }) => {
      expect(options).toMatchObject({ shell: false, windowsHide: true, env: { CODEX_THREAD_ID: "native-thread" } });
      expect(args).toContain("production");
      const channel = args[args.indexOf("--interactive-channel") + 1];
      const child = new EventEmitter();
      finished = (async () => {
        await writeFile(join(channel, "response-0.json"), JSON.stringify({ phase: "open", sequence: 0, screenshot: "AAAA", controls: [] }));
        for (let i = 0; i < 200; i++) {
          if ((await readdir(channel)).includes("request-1.json")) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(JSON.parse(await readFile(join(channel, "request-1.json"), "utf8"))).toEqual({ action: "finish" });
        await writeFile(join(channel, "production-stdout.txt"), JSON.stringify({ acquired: true, value: { revision: 9 } }));
        await writeFile(join(channel, "production-stderr.txt"), JSON.stringify({ workerProductionOutput: { payloadAvailable: true } }));
        child.emit("close", 0);
      })();
      return child;
    });
    const bridge = createCourseBrowserBridge({ cwd, threadId: "native-thread", nativeIdentityVerified: () => true, spawnProcess });
    try {
      const opened = await bridge.call({ action: "open", assignmentRef: "owned", token: "private", revision: 7, selectedCheckout: cwd, source: "booking" });
      expect(opened.success).toBe(true);
      expect(opened.contentItems[1]).toEqual({ type: "inputImage", imageUrl: "data:image/png;base64,AAAA" });
      const closed = await bridge.call({ action: "finish" });
      expect(closed.success).toBe(true);
      expect(JSON.parse(closed.contentItems[0].text).results[0]).toMatchObject({ acquired: true, value: { revision: 9 } });
      expect(spawnProcess).toHaveBeenCalledOnce();
      await finished;
    } finally {
      await bridge.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
