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
  const mode = process.argv[2] ?? "generic";
  assert(["generic", "square-calendar", "square-calendar-sensitive"].includes(mode));
  const square = mode !== "generic";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const expectedNames = square ? mode.endsWith("sensitive") ? [] : days.map((_, index) => `Date 2026-11-${15 + index}`)
    : ["Public calendar", "Next month"];
  const task = collectInteractiveSimulatorResearch({ url: square
    ? "https://book.squareup.com/appointments/publicvenue/location/AAAAAAAAAAAAA/availability" : "https://public.example.test/calendar", channel,
    assertOwned: async () => { assert(!stopped, "Fixture ended"); } }, {
    fetch: (async () => {
      mockedRequests++;
      return new Response(square ? `<html><body><style>market-button{display:inline-block;width:50px;height:50px}</style>
        <div data-testid="weekview-date-picker"><h2>Nov 2026</h2><div data-testid="present-week">
        ${days.map((day, index) => `<market-button type="button" aria-pressed="false" data-date="2026-11-${15 + index}"><div aria-label="${day}">${day.slice(0, 3)} ${15 + index}</div></market-button>`).join("")}
        </div></div><p id="selected"></p><button>4:00 PM</button>${mode.endsWith("sensitive") ? '<input type="email">' : ''}
        <script>customElements.define('market-button', class extends HTMLElement { connectedCallback() {
          const root=this.attachShadow({mode:'open'});root.innerHTML='<button type="button"><slot></slot></button>';
          root.querySelector('button').onclick=()=>{this.setAttribute('aria-pressed','true');document.querySelector('#selected').textContent='Selected '+this.dataset.date;};
        }});</script></body></html>` : `<html><body><h1>Public calendar</h1>
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
  let pendingSequence = 1;
  try {
    for (let i = 0; i < 200; i++) {
      const state = await Promise.race([settled, Promise.resolve(null)]);
      if (state) throw state.ok ? new Error("Collector ended before observation") : state.error;
      try {
        const snapshot = JSON.parse(await readFile(join(channel, "response-0.json"), "utf8"));
        assert.deepEqual(snapshot.controls.map((control: { name: string }) => control.name), expectedNames);
        let finishSequence = 1;
        if (mode === "square-calendar") {
          const target = snapshot.controls.find((control: { name: string }) => control.name === "Date 2026-11-20").target;
          await writeFile(join(channel, "request-1.json.tmp"), JSON.stringify({ action: "click", target }));
          await rename(join(channel, "request-1.json.tmp"), join(channel, "request-1.json"));
          pendingSequence = 2;
          let observed = false;
          for (let attempt = 0; attempt < 200; attempt++) {
            try { const next = JSON.parse(await readFile(join(channel, "response-1.json"), "utf8"));
              assert.match(next.text, /Selected 2026-11-20/u);
              assert.deepEqual(next.selectedCalendarFilters, [{ label: "Date", value: "2026-11-20" }]); observed = true; break;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            await new Promise(done => setTimeout(done, 50));
          }
          assert(observed, "Date selection must be independently visible");
          finishSequence = 2;
        }
        const finish = join(channel, `request-${finishSequence}.json`);
        await writeFile(`${finish}.tmp`, JSON.stringify({ action: "finish" })); await rename(`${finish}.tmp`, finish);
        const done = await settled;
        if (!done.ok) throw done.error;
        assert(mockedRequests > 0);
        console.log(JSON.stringify({ completed: true, controls: snapshot.controls.length, mode, mockedRequests,
          providerRequests: 0, databaseReads: 0 }));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error("Fixture observation timeout");
  } finally {
    // Release an outstanding fixture observation before waiting for cleanup,
    // including an assertion failure, so the original failure is not masked.
    const finish = join(channel, `request-${pendingSequence}.json`);
    await writeFile(`${finish}.tmp`, JSON.stringify({ action: "finish" })).then(() => rename(`${finish}.tmp`, finish)).catch(() => {});
    stopped = true;
    await settled;
    await rm(channel, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
