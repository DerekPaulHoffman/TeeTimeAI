import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { courseBrowserTool, createCourseBrowserBridge } from "./course-support-browser-bridge.mjs";

const pause = ms => new Promise(done => setTimeout(done, ms));
const fail = code => { throw new Error(code); };

async function privatePath(root, path, file = false) {
  const tail = relative(root, path);
  if (!tail || tail.startsWith("..") || isAbsolute(tail)) fail("DESKTOP_BROWSER_PATH_REJECTED");
  for (let current = path; current !== root; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current === path && file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) fail("DESKTOP_BROWSER_PATH_REJECTED");
  }
  if (await realpath(root) !== root) fail("DESKTOP_BROWSER_PATH_REJECTED");
}

async function readRequest(root, path) {
  await privatePath(root, path, true);
  if ((await lstat(path)).size > 16_384) fail("DESKTOP_BROWSER_REQUEST_REJECTED");
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { fail("DESKTOP_BROWSER_REQUEST_REJECTED"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("DESKTOP_BROWSER_REQUEST_REJECTED");
  const schema = courseBrowserTool.inputSchema;
  for (const [key, item] of Object.entries(value)) {
    const property = schema.properties[key];
    if (!property || (property.type === "integer" ? !Number.isSafeInteger(item) : typeof item !== property.type) ||
        property.enum && !property.enum.includes(item) || property.maxLength && item.length > property.maxLength ||
        property.minimum !== undefined && item < property.minimum || property.maximum !== undefined && item > property.maximum) fail("DESKTOP_BROWSER_REQUEST_REJECTED");
  }
  if (!schema.properties.action.enum.includes(value.action)) fail("DESKTOP_BROWSER_REQUEST_REJECTED");
  return value;
}

/** Desktop shell transport for the SAME owned bridge, not a second collector.
 * Keep this process's original exec handle alive. Publish one request file at a
 * time and poll that handle; no detached workers, caller URL or new claims.
 */
export async function runDesktopCourseBrowser(options, dependencies = {}) {
  const environment = options.environment || process.env;
  const threadId = environment.CODEX_THREAD_ID;
  if (typeof threadId !== "string" || !threadId.trim()) fail("DESKTOP_BROWSER_NATIVE_IDENTITY_REQUIRED");
  const cwd = await realpath(options.cwd || process.cwd());
  const root = resolve(cwd, ".codex-artifacts");
  const openPath = resolve(options.openRequest);
  const first = await readRequest(root, openPath);
  if (first.action !== "open" || first.selectedCheckout !== options.selectedCheckout) fail("DESKTOP_BROWSER_OPEN_REJECTED");
  const publish = dependencies.publish || (value => process.stdout.write(`${JSON.stringify(value)}\n`));
  const channelRoot = resolve(root, "browser-desktop");
  await mkdir(channelRoot, { recursive: true, mode: 0o700 });
  await privatePath(root, channelRoot);
  const channel = resolve(channelRoot, randomUUID());
  await mkdir(channel, { mode: 0o700 });
  const bridge = (dependencies.createBridge || createCourseBrowserBridge)({ cwd, threadId,
    nativeIdentityVerified: () => environment.CODEX_THREAD_ID === threadId });
  const now = dependencies.now || Date.now;
  const wait = dependencies.pause || pause;
  // The source operation has its own five-minute deadline. This transport also
  // has a finite lifetime if its owning Desktop turn disappears.
  const deadline = now() + 6 * 60_000;
  let sequence = 0;
  try {
    let request = first;
    for (;;) {
      if (environment.CODEX_THREAD_ID !== threadId) fail("DESKTOP_BROWSER_NATIVE_IDENTITY_REQUIRED");
      const result = await bridge.call(request);
      const content = [];
      for (const item of result.contentItems || []) {
        if (item.type !== "inputImage") { content.push(item); continue; }
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.imageUrl) || item.imageUrl.length > 3_000_100) fail("DESKTOP_BROWSER_IMAGE_REJECTED");
        const imagePath = resolve(channel, `observation-${sequence}.png`);
        await writeFile(imagePath, Buffer.from(item.imageUrl.split(",")[1], "base64"), { flag: "wx", mode: 0o600 });
        content.push({ type: "imagePath", path: imagePath });
      }
      const closed = request.action === "finish" || !result.success || (result.contentItems || []).some(item => {
        try { return item.type === "inputText" && JSON.parse(item.text).phase === "closed"; } catch { return false; }
      });
      const nextRequestPath = closed ? null : resolve(channel, `request-${sequence + 1}.json`);
      await publish({ sequence, success: result.success, closed, content, nextRequestPath });
      if (closed) return { outcome: result.success ? "completed" : "browser_failed", exitCode: result.success ? 0 : 2 };
      // Waiting for a local control file performs no provider I/O and never
      // repeats an unfinished source operation. Atomically rename a .tmp file.
      for (;;) {
        if (now() >= deadline) fail("DESKTOP_BROWSER_DEADLINE");
        try { request = await readRequest(root, nextRequestPath); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await wait(100);
      }
      sequence++;
      if (request.action === "open" || Object.keys(request).some(key => !["action", "target", "option", "text", "direction"].includes(key))) fail("DESKTOP_BROWSER_REQUEST_REJECTED");
    }
  } finally {
    // Settle only the original source read. No new source or retry is started.
    await bridge.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--open-request" || args[2] !== "--selected-checkout") fail("DESKTOP_BROWSER_ARGUMENTS_REJECTED");
    const result = await runDesktopCourseBrowser({ openRequest: args[1], selectedCheckout: args[3] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: "desktop_browser_failed", error: /^DESKTOP_BROWSER_[A-Z_]+$/.test(error.message || "") ? error.message : "DESKTOP_BROWSER_FAILED",
      instruction: "Retain the original process and source evidence; do not replay, re-claim or open a replacement browser." })}\n`);
    process.exitCode = 2;
  }
}
