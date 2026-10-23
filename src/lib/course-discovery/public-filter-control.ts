import type { Locator } from "@playwright/test";
import { publicRentalDurationMinutes } from "./recipe";
import { inspectPublicDropdown, selectPublicDropdown } from "./public-dropdown-control";
import { inspectPublicMenuButton, selectPublicMenuButton } from "./public-duration-button";
import { trySelectPublicPlayerCombobox } from "./public-player-combobox";

/** Select a displayed filter, never a time or transaction control. */
export async function selectPublicFilter(node: Locator, input: {
  value: string; purpose: string; simulator: boolean;
}) {
  if (await node.count() !== 1 || !await node.isVisible() || !await node.isEnabled()) throw new Error("AMBIGUOUS_CONTROL");
  if (input.simulator && input.purpose === "PLAYERS" && input.value !== "1") throw new Error("UNSAFE_CONTROL");
  const tag = await node.evaluate(element => element.tagName.toLowerCase());
  if (tag === "select") {
    await node.selectOption(input.value);
    return;
  }
  if (input.purpose === "PLAYERS" && await trySelectPublicPlayerCombobox(node, input.value, input.simulator)) return;
  if ((input.purpose === "DURATION" || input.purpose === "PLAYERS") && await inspectPublicMenuButton(node, input.purpose))
    return selectPublicMenuButton(node, input.value, input.purpose);
  if (await inspectPublicDropdown(node)) return selectPublicDropdown(node, input);
  if (!["DURATION", "PLAYERS"].includes(input.purpose) || !/^[1-9]\d{0,2}$/u.test(input.value) ||
      Number(input.value) > (input.purpose === "DURATION" ? 480 : 20) ||
      input.simulator && input.purpose === "PLAYERS" && input.value !== "1") throw new Error("UNSAFE_CONTROL");
  const observed = await node.evaluate(element => {
    const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
      .map(id => document.getElementById(id)?.textContent ?? "").join(" ");
    let nearby = "";
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 3 && parent.tagName !== "FORM"; depth++, parent = parent.parentElement) {
      const labels = Array.from(parent.querySelectorAll("label")).map(label => label.textContent ?? "").join(" ");
      if (labels.length <= 200) { nearby = labels; if (nearby.trim()) break; }
    }
    return { role: element.getAttribute("role"), label: `${element.getAttribute("aria-label") ?? ""} ${labelled} ${nearby}`.trim(),
      sensitive: Boolean(element.closest("form")?.querySelector('input[type="password"],input[type="email"],input[type="tel"],[autocomplete^="cc-"]')) };
  });
  const expectedLabel = input.purpose === "DURATION" ? /\b(?:duration|length)\b/iu : /\b(?:players?|party|guests?|group|bays?)\b/iu;
  if (observed.role !== "combobox" || observed.sensitive || !expectedLabel.test(observed.label) ||
      /\b(?:book|reserve|checkout|pay|purchase|login|password)\b/iu.test(observed.label)) throw new Error("UNSAFE_CONTROL");
  await node.click();
  const choices = node.page().getByRole("option");
  // Rendering the list may be asynchronous; wait for its presence without
  // choosing an arbitrary option when several match the requested value.
  await choices.filter({ visible: true }).first().waitFor({ state: "visible" });
  if (await choices.count() > 40) throw new Error("AMBIGUOUS_CONTROL");
  const matching: Locator[] = [];
  for (const choice of await choices.all()) {
    if (!await choice.isVisible() || !await choice.isEnabled()) continue;
    const value = await choice.getAttribute("data-value") ?? await choice.getAttribute("value");
    if (value === input.value) matching.push(choice);
  }
  if (matching.length !== 1) throw new Error("AMBIGUOUS_CONTROL");
  const choice = matching[0];
  const text = (await choice.innerText()).replace(/\s+/gu, " ").trim();
  const metadata = await choice.evaluate(element => ({ href: element.getAttribute("href"),
    sensitive: Boolean(element.closest("form")?.querySelector('input[type="password"],input[type="email"],input[type="tel"],[autocomplete^="cc-"]')) }));
  const validText = input.purpose === "DURATION" ? publicRentalDurationMinutes(text) === Number(input.value)
    : new RegExp(`^${input.value}(?:\\s+(?:players?|people|guests?|bays?))?$`, "iu").test(text);
  if (!validText || metadata.href || metadata.sensitive) throw new Error("UNSAFE_CONTROL_VALUE");
  await choice.click();
}
