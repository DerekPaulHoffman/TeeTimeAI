export type WorkerTerminalDiagnostic = { version: 1; failureCode: string; frameworkPhase: "GENERIC_FALLBACK" | "STAGEHAND" | "WORKER"; errorName: string };
export function makeWorkerTerminalDiagnostic(error: unknown): WorkerTerminalDiagnostic;
export function parseWorkerTerminalDiagnostic(value: unknown): WorkerTerminalDiagnostic | undefined;
