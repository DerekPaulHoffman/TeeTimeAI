export function getCourseSupportEffectiveVerificationEndpoint(input: {
  now: Date;
  escalationDeadlineAt: Date | null;
  engineeringOnly: boolean;
  activeRealSearchCount: number;
  earliestTargetDate: Date | null;
  activeFutureOutdoorSearchCount: number;
  ownedLeaseSnapshotAt?: Date | null;
}) {
  const historical = input.escalationDeadlineAt;
  const snapshot = input.ownedLeaseSnapshotAt;
  if (
    historical &&
    historical.getTime() <= input.now.getTime() &&
    input.engineeringOnly &&
    input.activeRealSearchCount === 0 &&
    input.earliestTargetDate === null &&
    input.activeFutureOutdoorSearchCount === 0 &&
    snapshot &&
    Number.isFinite(snapshot.getTime()) &&
    snapshot.getTime() > input.now.getTime()
  ) {
    return snapshot;
  }
  return historical;
}
