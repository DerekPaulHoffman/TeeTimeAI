import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { registerStagehandSourceWorkerDenial, requireDeniedStagehandTargetClosed, stagehandSourceWorkerDenialScript } from "./stagehand-source-browser";

it("makes both source-page worker constructors unavailable and nonreplaceable before site code", () => {
  const dom = new JSDOM("<body>Public source</body>", { runScripts: "outside-only" });
  let execution = 0;
  dom.window.Worker = function () { execution++; } as unknown as typeof Worker;
  Object.defineProperty(dom.window, "SharedWorker", { value: function () { execution++; }, configurable: true });
  dom.window.eval(stagehandSourceWorkerDenialScript);
  for (const name of ["Worker", "SharedWorker"]) {
    const descriptor = Object.getOwnPropertyDescriptor(dom.window, name)!;
    expect(descriptor).toMatchObject({ value: undefined, writable: false, configurable: false });
    expect(dom.window.eval(`typeof ${name}`)).toBe("undefined");
    expect(dom.window.eval(`Reflect.set(globalThis,'${name}',function(){})`)).toBe(false);
    expect(dom.window.eval(`Reflect.deleteProperty(globalThis,'${name}')`)).toBe(false);
    expect(() => dom.window.eval(`new ${name}('/escape-worker.js')`)).toThrow();
  }
  expect(execution).toBe(0); dom.window.close();
});
it("pre-registers only fixed future-document main-world source on the owned context and preserves registration failures", async () => {
  const addInitScript = vi.fn(async () => {});
  await registerStagehandSourceWorkerDenial({ addInitScript });
  expect(addInitScript).toHaveBeenCalledExactlyOnceWith({ content: stagehandSourceWorkerDenialScript });
  const original = Error("OWNED_STAGEHAND_CDP_UNAVAILABLE");
  await expect(registerStagehandSourceWorkerDenial({ addInitScript: async () => { throw original; } })).rejects.toBe(original);
});
it("installs before resuming owned pages while retaining strict worker backstop and no roster-absence exception", () => {
  const code = readFileSync("src/lib/course-discovery/stagehand-source-browser.ts", "utf8");
  expect(code.indexOf("await registerStagehandSourceWorkerDenial(context)")).toBeLessThan(code.indexOf('root.on("Target.attachedToTarget"'));
  expect(code.indexOf("await registerStagehandSourceWorkerDenial(context)")).toBeLessThan(code.indexOf('root.send("Target.createTarget"'));
  expect(code).not.toContain("await registerStagehandSourceWorkerDenial(child)");
  expect(code).toContain('deniedWorkers++; await requireDeniedStagehandTargetClosed(root, info.targetId); return;');
  expect(code).not.toContain("closeDeniedStagehandTarget");
  expect(code).toContain('serviceWorkers: "block"');
});
it("fails closed on any unsuccessful or malformed denied-target close without resume, detach or roster inference", async () => {
  for (const result of [{ success: false }, {}, { success: 1 }, { success: "true" }]) {
    const send = vi.fn(async () => result);
    await expect(requireDeniedStagehandTargetClosed({ send }, "denied-target")).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
    expect(send).toHaveBeenCalledExactlyOnceWith("Target.closeTarget", { targetId: "denied-target" });
  }
  const original = Error("OWNED_STAGEHAND_CDP_UNAVAILABLE");
  await expect(requireDeniedStagehandTargetClosed({ send: async () => { throw original; } }, "denied-target")).rejects.toBe(original);
  const send = vi.fn(async () => ({ success: true }));
  await requireDeniedStagehandTargetClosed({ send }, "denied-target"); expect(send).toHaveBeenCalledOnce();
});
