export const SEARCH_MODES = ["OUTDOOR", "SIMULATOR"] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

export const MAX_OUTDOOR_PLAYERS = 4;
export const MAX_SIMULATOR_PLAYERS = 4;
export const DEFAULT_SIMULATOR_DURATION_MINUTES = 60;
export const SIMULATOR_DURATION_OPTIONS_MINUTES = [60, 90, 120, 180] as const;

export function normalizeSearchMode(value: string | null | undefined): SearchMode {
  return value === "SIMULATOR" ? "SIMULATOR" : "OUTDOOR";
}

export function maxPlayersForMode(mode: SearchMode) {
  return mode === "SIMULATOR" ? MAX_SIMULATOR_PLAYERS : MAX_OUTDOOR_PLAYERS;
}
