import { describe, expect, it } from "vitest";

import { runProviderFamilyTasks } from "./provider-concurrency";

describe("runProviderFamilyTasks", () => {
  it("runs at most two tasks and never overlaps one provider family", async () => {
    const activeFamilies = new Set<string>();
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const items = [
      { id: "a1", family: "A" },
      { id: "a2", family: "A" },
      { id: "b1", family: "B" },
      { id: "c1", family: "C" }
    ];

    await runProviderFamilyTasks(
      items,
      (item) => item.family,
      async (item) => {
        expect(activeFamilies.has(item.family)).toBe(false);
        activeFamilies.add(item.family);
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        completed.push(item.id);
        active -= 1;
        activeFamilies.delete(item.family);
      }
    );

    expect(peak).toBe(2);
    expect(completed).toHaveLength(items.length);
  });

  it("caps a requested concurrency above two", async () => {
    let active = 0;
    let peak = 0;
    await runProviderFamilyTasks(
      ["A", "B", "C"],
      (family) => family,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
      },
      20
    );
    expect(peak).toBe(2);
  });
});
