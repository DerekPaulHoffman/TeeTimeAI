import { z } from "zod";
import type { AccessExecutionInput } from "./recipe";

const parameterNames = ["date", "dateCompact", "timeZone", "players", "durationMinutes", "startTime", "endTime", "day", "month", "year"] as const;
export const recipeTemplateSchema = z.string().min(1).max(2048).refine(value => {
  const replaced = value.replace(/\{\{([A-Za-z]+)\}\}/gu, (_, name: string) =>
    parameterNames.includes(name as typeof parameterNames[number]) ? "x" : "{");
  return !/[{}\r\n]/u.test(replaced);
}, "Unknown or malformed template parameter").describe("Use {{date}} for YYYY-MM-DD or {{dateCompact}} for zero-padded YYYYMMDD. Existing {{year}}, {{month}} and {{day}} bindings retain numeric month/day semantics. Other supported inputs are timeZone, players, durationMinutes, startTime and endTime; referenced inputs must be present.");

export const recipeLocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

/** Pure bindings only. Request URL safety remains the caller's responsibility. */
export function expandRecipeTemplate(template: string, input: Pick<AccessExecutionInput, "date"> & Partial<Omit<AccessExecutionInput, "date">>, urlEncoded = false) {
  recipeTemplateSchema.parse(template);
  const date = recipeLocalDateSchema.parse(input.date), [year, month, day] = date.split("-");
  const values: Record<string, string | number | undefined> = { ...input, dateCompact: date.replaceAll("-", ""), year, month: Number(month), day: Number(day) };
  return template.replace(/\{\{([A-Za-z]+)\}\}/gu, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error("A required recipe parameter is missing");
    return urlEncoded ? encodeURIComponent(String(value)) : String(value);
  });
}
