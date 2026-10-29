import { z } from "zod";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { lightspeedFlightObjects } from "./lightspeed-source";
import { completeUSAddress, fullCourseName } from "./teeitup-official-identity";

/** Routing facts only. These never substitute for the real facility directory. */
export const teeItUpBookingConfigurationSchema = z.object({
  apiAlias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
  facilityIds: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(20)
    .refine(ids => new Set(ids).size === ids.length && ids.every((value, i) => i === 0 || ids[i - 1] < value)),
}).strict();
export type TeeItUpBookingConfiguration = z.infer<typeof teeItUpBookingConfigurationSchema>;

/** Literal Next Flight JSON from the exact public booking document. No script
 * execution, preceding-alias heuristic, guessed sibling tenant or partial rows. */
export function parseTeeItUpBookingConfiguration(html: string, venueName: string, selectedFacilityIds?: readonly number[], venueAddress?: string): TeeItUpBookingConfiguration {
  const reject = (): never => { throw new Error("ADAPTER_CONFIGURATION_UNVERIFIED"); };
  if (Buffer.byteLength(html) > 600_000 || fullCourseName(venueName).length < 8) return reject();
  const objects: Record<string, unknown>[] = [];
  const decode = (document: string) => { try { objects.push(...lightspeedFlightObjects(document)); } catch { /* A literal chunk can contain only a non-JSON Flight record. */ } };
  decode(html);
  // Next may place a complete root record in its own literal chunk immediately
  // after a text record without a newline. Decode that framing independently;
  // also retain joined-stream support for records split across literal chunks.
  type Node = DefaultTreeAdapterMap["node"];
  const stack: Array<{ node: Node; depth: number }> = [{ node: parse(html), depth: 0 }];
  let visits = 0, scripts = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++visits > 20_000 || depth > 80 || objects.length > 60_000) return reject();
    if ("tagName" in node && node.tagName === "script" && !node.attrs.some(attr => attr.name === "src")) {
      if (++scripts > 400) return reject();
      const script = node.childNodes.filter(child => child.nodeName === "#text").map(child => (child as DefaultTreeAdapterMap["textNode"]).value).join("").trim();
      if (/^self\.__next_f\.push\(\[[\s\S]*\]\);?$/u.test(script)) decode(`<script>${script}</script>`);
    }
    if ("childNodes" in node) for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 });
  }
  const candidates = objects.filter(row => Object.hasOwn(row, "alias") && Object.hasOwn(row, "gnFacilityIds"));
  if (!candidates.length || candidates.length > 20) return reject();
  const parsed = candidates.map(row => {
    if (typeof row.name !== "string" || !Array.isArray(row.gnFacilityIds)) return reject();
    const ids = row.gnFacilityIds;
    if (!ids.every(value => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647) || new Set(ids).size !== ids.length) return reject();
    // Some public profiles append the location's state to the course label.
    // Admit that routing label only against the complete saved address. The
    // refreshed facility directory still owns name/address/timezone identity.
    const locatedName = /^(.+), ([A-Z]{2})$/u.exec(row.name);
    const region = venueAddress ? completeUSAddress(venueAddress)?.region : undefined;
    const sameLocatedName = locatedName && region === locatedName[2] &&
      fullCourseName(locatedName[1]) === fullCourseName(venueName);
    if (fullCourseName(row.name) !== fullCourseName(venueName) && !sameLocatedName) {
      // A multi-course public profile names the operator. Only the one course
      // selected by the observed URL may earn its published directory alias.
      // This is routing, not identity: the real refreshed directory must still
      // independently verify the canonical venue, full address and timezone.
      const selected = selectedFacilityIds?.length === 1 ? selectedFacilityIds[0] : undefined;
      if (row.name.length < 2 || row.name.length > 256 || !Number.isSafeInteger(selected) || !ids.includes(selected) || ids.length < 2 || row.entityType !== "course" ||
          !Array.isArray(row.rates) || !row.rates.length || row.rates.length > 500 ||
          row.rates.some(rate => !rate || typeof rate !== "object" || Array.isArray(rate) ||
            !Number.isSafeInteger(rate.golfFacilityId) || rate.golfFacilityId < 1 || rate.golfFacilityId > 2_147_483_647)) return reject();
      const selectedRows = row.rates.filter(rate => rate.golfFacilityId === selected);
      if (!selectedRows.length || selectedRows.some(rate => typeof rate.gFName !== "string" || rate.gFName.length > 256 ||
          fullCourseName(rate.gFName) !== fullCourseName(venueName) || rate.gCPlayFacilityId !== selected ||
          typeof rate.showOnBE !== "boolean" || typeof rate.isMemberRate !== "boolean")) return reject();
      const published = selectedRows.filter(rate => rate.showOnBE === true);
      if (published.length !== 1 || published[0].isMemberRate !== false || published[0].membershipId !== null ||
          published[0].gFStatus !== "Active" || published[0].gCStatus !== "Active") return reject();
    }
    const value = teeItUpBookingConfigurationSchema.safeParse({ apiAlias: row.alias, facilityIds: [...ids].sort((a, b) => Number(a) - Number(b)) });
    return value.success ? value.data : reject();
  });
  const unique = new Map(parsed.map(value => [JSON.stringify(value), value]));
  if (unique.size !== 1) return reject();
  return [...unique.values()][0];
}
