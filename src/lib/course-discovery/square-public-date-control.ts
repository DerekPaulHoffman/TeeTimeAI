/** Public Square week strip. Never a time button or a customer date field. */
export function inspectSquarePublicDateElement(element: Element, current?: { date: string }) {
  if (!/^https:\/\/book\.squareup\.com\/appointments\/[a-z0-9]{1,64}\/location\/[A-Z0-9]{13}\/availability$/u.test(document.location.href)) return;
  const root = element.getRootNode(), host = root instanceof ShadowRoot ? root.host : element;
  if (host.tagName !== "MARKET-BUTTON" || host.getAttribute("type") !== "button" || host.hasAttribute("disabled") ||
      host.getAttribute("aria-disabled") === "true" || host.hasAttribute("onclick") || host.closest("form,a[href]")) return;
  const strip = host.closest('[data-testid="present-week"]'), week = strip?.closest('[data-testid="weekview-date-picker"]');
  if (!strip || !week || strip.getAttribute("aria-hidden") === "true" || week.querySelectorAll("*").length > 400 ||
      week.querySelector('input,select,textarea,form,a[href],[data-slot-id],[data-start-time]')) return;
  let ancestor: Element | null = host;
  for (let i = 0; ancestor && i < 40; i++) {
    const style = getComputedStyle(ancestor);
    if (ancestor.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
    ancestor = ancestor.parentElement;
  }
  if (ancestor || !host.getBoundingClientRect().width || !host.getBoundingClientRect().height) return;
  if (Array.from(document.querySelectorAll('input[type="email"],input[type="tel"],input[type="password"],input[autocomplete^="cc-"]')).some(node => {
    const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden";
  })) return;
  const headings = week.querySelectorAll("h2"), months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = headings.length === 1 && /^(\w{3}) (20\d{2})$/u.exec(headings[0].textContent?.trim() ?? "");
  if (!month || !months.includes(month[1])) return;
  const buttons = Array.from(strip.querySelectorAll("market-button"));
  if (buttons.length !== 7 || !buttons.includes(host)) return;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], dates: string[] = [];
  for (const [index, button] of buttons.entries()) {
    const labels = button.querySelectorAll("div[aria-label]"), label = labels.length === 1 ? labels[0].getAttribute("aria-label") : null;
    const dayText = (button.textContent ?? "").replace(/\s+/gu, " ").trim(), match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s*(\d{1,2})$/u.exec(dayText);
    if (!match || label !== days[index] || match[1] !== days[index].slice(0, 3) || button.getAttribute("type") !== "button" ||
        !["true", "false"].includes(button.getAttribute("aria-pressed") ?? "")) return;
    const parsed = new Date(Date.UTC(Number(month[2]), months.indexOf(month[1]), Number(match[2])));
    if (parsed.getUTCMonth() !== months.indexOf(month[1]) || parsed.getUTCDay() !== index || Number(match[2]) !== parsed.getUTCDate()) return;
    const date = parsed.toISOString().slice(0, 10);
    if (dates.length && Date.parse(date) - Date.parse(dates[dates.length - 1]) !== 86_400_000) return;
    dates.push(date);
  }
  const date = dates[buttons.indexOf(host)];
  if (current && current.date !== date) return;
  return { date, ...(host.getAttribute("aria-pressed") === "true" ? { alreadySelected: true as const } : {}) };
}
