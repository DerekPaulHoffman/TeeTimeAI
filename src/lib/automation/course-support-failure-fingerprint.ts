const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/iu;

export function normalizeCourseSupportFailureFingerprint(value: string) {
  const trimmed = value.trim();
  if (SHA256_FINGERPRINT.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const normalized = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9:._-]/gu, "_")
    .slice(0, 160);
  return normalized || "UNKNOWN";
}

export function courseSupportFailureFingerprintsMatch(
  left: string,
  right: string,
) {
  return (
    normalizeCourseSupportFailureFingerprint(left) ===
    normalizeCourseSupportFailureFingerprint(right)
  );
}
