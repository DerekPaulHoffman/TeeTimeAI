import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { collectInteractiveSimulatorResearch } from "../../../../src/lib/automation/simulator-interactive-browser";

async function main() {
  assert(!process.env.DATABASE_URL && !process.env.DATABASE_URL_UNPOOLED, "Fixture must remain offline");
  const root = resolve(".codex-artifacts/browser");
  const channel = resolve(root, `runtime-fixture-${randomUUID()}`);
  assert(channel.startsWith(root + sep));
  await mkdir(channel, { recursive: true });
  let stopped = false;
  let mockedRequests = 0;
  const task = collectInteractiveSimulatorResearch({ url: "https://public.example.test/calendar", channel,
    assertOwned: async () => { assert(!stopped, "Fixture ended"); } }, {
    fetch: (async () => {
      mockedRequests++;
      return new Response(`<html><body><h1>Public calendar</h1>
        <market-row href="/calendar"><span slot="label">Public calendar</span></market-row>
        <button>Next month</button><script>
        customElements.define('market-row', class extends HTMLElement { connectedCallback() {
          const root=this.attachShadow({mode:'open'});
          root.innerHTML='<a href="/calendar"><slot name="label"></slot></a>';
        }});</script></body></html>`, { headers: { "content-type": "text/html" } });
    }) as typeof fetch,
    lease: (async (_family: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })) as never,
  });
  const settled = task.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    for (let i = 0; i < 200; i++) {
      const state = await Promise.race([settled, Promise.resolve(null)]);
      if (state) throw state.ok ? new Error("Collector ended before observation") : state.error;
      try {
        const snapshot = JSON.parse(await readFile(join(channel, "response-0.json"), "utf8"));
        assert.deepEqual(snapshot.controls.map((control: { name: string }) => control.name), ["Public calendar", "Next month"]);
        await writeFile(join(channel, "request-1.json.tmp"), JSON.stringify({ action: "finish" }));
        await rename(join(channel, "request-1.json.tmp"), join(channel, "request-1.json"));
        const done = await settled;
        if (!done.ok) throw done.error;
        assert(mockedRequests > 0);
        console.log(JSON.stringify({ completed: true, controls: snapshot.controls.length, mockedRequests,
          providerRequests: 0, databaseReads: 0 }));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error("Fixture observation timeout");
  } finally {
    stopped = true;
    await settled;
    await rm(channel, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
