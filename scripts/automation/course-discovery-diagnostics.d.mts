export type BrowserActionIssue = { path: string; code: string; keys?: string[] };
export function safeBrowserActionIssues(value: unknown): BrowserActionIssue[] | undefined;
