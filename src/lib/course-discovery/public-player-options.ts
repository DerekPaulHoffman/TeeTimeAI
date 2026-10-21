export type PublicPlayerOptions = {
  allowedPlayers: number[];
  minPlayers: number;
  maxPlayers: number;
};

/** Parse a complete, explicitly labelled party-choice statement.
 *
 * "4 players" allows exactly four; it does not mean one through four are
 * available. Bare numeric capacity counts remain the caller's separate
 * semantics. min/max summarize the returned set: membership must still use
 * allowedPlayers, since "1 or 4 players" does not allow two or three.
 */
export function parsePublicPlayerOptions(value: unknown): PublicPlayerOptions | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  const text = value.trim().replace(/\s+/gu, " ").toLowerCase();
  const match = /^([1-9]\d{0,2})(?: (to|or) ([1-9]\d{0,2}))? players?$/u.exec(text);
  if (!match) return undefined;
  const first = Number(match[1]), second = match[3] === undefined ? undefined : Number(match[3]);
  if (first > 100 || second !== undefined && second > 100) return undefined;

  let allowedPlayers: number[];
  if (second === undefined) allowedPlayers = [first];
  else if (match[2] === "to") {
    if (first > second) return undefined;
    allowedPlayers = Array.from({ length: second - first + 1 }, (_value, index) => first + index);
  } else {
    if (first === second) return undefined;
    allowedPlayers = [first, second].sort((left, right) => left - right);
  }
  return { allowedPlayers, minPlayers: allowedPlayers[0], maxPlayers: allowedPlayers[allowedPlayers.length - 1] };
}
