export type BrowserActionIssue = { path: string; code: string; keys?: string[] };
export function safeBrowserActionIssues(value: unknown): BrowserActionIssue[] | undefined;
export type DiscoveryTurnFailure = { turnStatus: "failed" | "interrupted" | "inProgress"; errorCategory?: string; httpStatusCode?: number };
export function safeDiscoveryTurnFailure(value: unknown): DiscoveryTurnFailure | undefined;
export type PublicUrlDiagnosticMethod = "GET" | "HEAD" | "POST" | "OPTIONS" | "PUT" | "PATCH" | "DELETE" | "OTHER";
export type PublicUrlDiagnosticResource = "document" | "script" | "stylesheet" | "xhr" | "fetch" | "other" | "image" | "font" | "media" | "manifest" | "eventsource" | "websocket" | "ping";
export type PublicUrlDiagnosticStage = "BROWSER_REQUEST_URL" | "PINNED_TRANSPORT_URL";
export type PublicUrlQueryKey = "version" | "product" | "parentname" | "date" | "players" | "courseid" | "teeofftimemin" | "teeofftimemax" |
  "apikey" | "api_key" | "key" | "token" | "access_token" | "session" | "sessionid" | "sid" | "code" | "state" | "email" | "phone" | "nonce" | "signature" | "timestamp" | "OTHER";
export type PublicUrlQueryValueClass = "EMPTY" | "BOOLEAN" | "INTEGER" | "DECIMAL" | "LOCAL_DATE" | "DOTTED_VERSION" | "URL_LIKE" | "OPAQUE_LIKE" | "TEXT" | "CONTROL" | "VALUE_LIMIT";
export type PublicUrlRejectionDiagnostic = {
  originalUrlSha256: string; checkedUrlSha256: string; method: PublicUrlDiagnosticMethod; resourceType: PublicUrlDiagnosticResource;
  stage: PublicUrlDiagnosticStage; validatorCategory: "PUBLIC_RECIPE_OR_STATIC_ASSET";
  queryParseStatus: "PARSED" | "INVALID" | "LIMIT"; queryCount: number | null;
  queryKeys: Array<{ key: PublicUrlQueryKey; occurrences: number; valueClasses: PublicUrlQueryValueClass[] }>;
  queryTruncated: boolean; queryFreeValidation: "PASSED" | "REJECTED" | "UNAVAILABLE";
  queryFreeRecipeValid?: boolean; queryFreeAssetValid?: boolean;
};
export function safePublicUrlRejectionDiagnostic(value: unknown): PublicUrlRejectionDiagnostic | undefined;
export function describePublicUrlRejection(originalUrl: string, checkedUrl: string, method: string, resourceType: string,
  stage: PublicUrlDiagnosticStage, validators: { recipe(value: string): boolean; asset(value: string, resourceType: string, method: string): boolean }): PublicUrlRejectionDiagnostic | undefined;
