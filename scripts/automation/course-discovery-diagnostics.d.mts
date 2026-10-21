export type BrowserActionIssue = { path: string; code: string; keys?: string[] };
export function safeBrowserActionIssues(value: unknown): BrowserActionIssue[] | undefined;
export type DiscoveryTurnFailure = { turnStatus: "failed" | "interrupted" | "inProgress"; errorCategory?: string; httpStatusCode?: number };
export function safeDiscoveryTurnFailure(value: unknown): DiscoveryTurnFailure | undefined;
