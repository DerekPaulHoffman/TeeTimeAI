import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { freshNativeCanonicalRootDocument, isFreshNativeDelegatedDocument, isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { delegatedBookingHop, type DelegatedHop } from "./teeitup-delegated-booking-source";
import type { DelegatedDiagnosticGate } from "./teeitup-delegated-booking-diagnostic";
import type { NativePhysicalContactSource } from "./teeitup-physical-contact-proof";

declare const grantBrand: unique symbol;
export type DelegatedGetGrant = object & { readonly [grantBrand]: true };
const grants = new WeakMap<DelegatedGetGrant, { page: OfficialIdentityPage; officialUrl: string; hop: DelegatedHop; deadline: number; used: boolean }>();
const fail = (): never => { throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED"); };
declare const budgetBrand: unique symbol;
export type DelegatedReadBudget = object & { readonly [budgetBrand]: true };
type Resource = "requests" | "bytes" | "intercepts" | "tunnelBytes" | "connections";
const limits = { requests: 192, bytes: 48000000, intercepts: 1024, tunnelBytes: 24000000, connections: 192 } as const;
const budgets = new WeakMap<DelegatedReadBudget, { deadline: number; counts: Record<Resource, number> }>();
export function createDelegatedReadBudget(deadline: Date) {
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) return fail();
  const token = Object.freeze({}) as DelegatedReadBudget;
  budgets.set(token, { deadline: deadline.getTime(), counts: { requests: 0, bytes: 0, intercepts: 0, tunnelBytes: 0, connections: 0 } });
  return token;
}
export function chargeDelegatedReadBudget(token: DelegatedReadBudget, resource: Resource, count = 1) {
  const value = budgets.get(token);
  if (!value || !Number.isSafeInteger(count) || count < 0 || Date.now() >= value.deadline) return fail();
  value.counts[resource] += count;
  if (value.counts[resource] > limits[resource]) throw new Error(resource === "requests" || resource === "intercepts" ? "PUBLIC_READ_REQUEST_LIMIT" : "PUBLIC_READ_BYTE_LIMIT");
}
export function delegatedProxyAllocation(token: DelegatedReadBudget) {
  const value = budgets.get(token);
  if (!value || Date.now() >= value.deadline || value.counts.tunnelBytes >= limits.tunnelBytes || value.counts.connections >= limits.connections) return fail();
  return { maxBytes: limits.tunnelBytes - value.counts.tunnelBytes, maxConnections: limits.connections - value.counts.connections };
}
/** Final usage accounting remains possible after the deadline. It cannot
 * authorize a read or replenish any allocation. */
export function settleDelegatedProxyBudget(token: DelegatedReadBudget, stats: { bytes: number; connections: number }) {
  const value = budgets.get(token);
  if (!value || !Number.isSafeInteger(stats.bytes) || stats.bytes < 0 || !Number.isSafeInteger(stats.connections) || stats.connections < 0) return fail();
  value.counts.tunnelBytes += stats.bytes; value.counts.connections += stats.connections;
  if (value.counts.tunnelBytes > limits.tunnelBytes || value.counts.connections > limits.connections) throw new Error("PUBLIC_READ_BYTE_LIMIT");
}
export function freshDelegatedPage(page: OfficialIdentityPage, root: string) {
  return isFreshNativeOfficialIdentityPage(page, root) || isFreshNativeDelegatedDocument(page, root);
}
/** One exact native observation authorizes one next GET only. Serialized or
 * foreign tokens, changed pages and expired source documents confer nothing. */
export function authorizeDelegatedGet(page: OfficialIdentityPage, officialUrl: string, deadline: Date, requestedNext?: string,
  onGate?: (key: DelegatedDiagnosticGate, value: boolean) => void) {
  if (!freshDelegatedPage(page, officialUrl) || !Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) return fail();
  const hop = delegatedBookingHop(page, requestedNext, onGate), token = Object.freeze({}) as DelegatedGetGrant;
  grants.set(token, { page, officialUrl, hop, deadline: deadline.getTime(), used: false });
  return { token, hop };
}
export function consumeDelegatedGet(token: DelegatedGetGrant) {
  const value = grants.get(token);
  if (!value || value.used || Date.now() >= value.deadline || !freshDelegatedPage(value.page, value.officialUrl)) return fail();
  value.used = true;
  return { officialUrl: value.officialUrl, url: value.hop.nextUrl, deadlineAt: new Date(value.deadline) };
}

declare const chainBrand: unique symbol;
export type NativeDelegatedChainToken = object & { readonly [chainBrand]: true };
const chains = new WeakMap<NativeDelegatedChainToken, { root: OfficialIdentityPage; final: OfficialIdentityPage; officialUrl: string;
  bookingUrl: string; rootWitnessSha256: string; hops: DelegatedHop[]; deadline: number; physicalContactSource?: NativePhysicalContactSource; physicalContactRequired?: true }>();
export function registerNativeDelegatedChain(value: { root: OfficialIdentityPage; final: OfficialIdentityPage; officialUrl: string;
  bookingUrl: string; rootWitnessSha256: string; hops: DelegatedHop[]; deadline: number; physicalContactSource?: NativePhysicalContactSource; physicalContactRequired?: true }) {
  const token = Object.freeze({}) as NativeDelegatedChainToken;
  chains.set(token, value); return token;
}
export function currentNativeDelegatedChain(token: NativeDelegatedChainToken) {
  const value = chains.get(token);
  if (!value || Date.now() >= value.deadline || !isFreshNativeOfficialIdentityPage(value.root, value.officialUrl) ||
      !isFreshNativeDelegatedDocument(value.final, value.officialUrl) || value.final.url !== value.bookingUrl) return fail();
  const rootDocumentProof = freshNativeCanonicalRootDocument(value.root, value.officialUrl)?.rootDocumentProof;
  return { rootWitnessSha256: value.rootWitnessSha256, hops: value.hops.map(hop => ({ ...hop })), ...(rootDocumentProof ? { rootDocumentProof } : {}),
    ...(value.physicalContactSource ? { physicalContactSource: structuredClone(value.physicalContactSource) } : {}), ...(value.physicalContactRequired ? { physicalContactRequired: true as const } : {}) };
}
