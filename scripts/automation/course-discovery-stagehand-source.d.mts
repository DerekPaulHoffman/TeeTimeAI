export function canonicalStagehandData(value: unknown): string;
export function publicStagehandSourceUrl(value: unknown): value is string;
export function observedInspectionPath(report: unknown, officialUrl: unknown, bookingUrl: unknown): string[];
export interface RetainedStagehandRoutingReport {
  finishedAt: string;
  adapterSourceProposal: { bookingUrl: string } | null;
  officialLinkLedger?: Array<{ pageUrl: string; kind?: string; links?: Array<{ href: string; visible?: boolean; text?: string; label?: string }> }>;
  actions?: Array<{ sourceUrl: string; action?: { method?: string }; observedTarget: { href: string; tag?: string }; afterUrl: string; error?: boolean }>;
}
export function createStagehandSourceCheckpoint(job: unknown, report: unknown): {
  reportSha256: string;
  report: RetainedStagehandRoutingReport;
};
