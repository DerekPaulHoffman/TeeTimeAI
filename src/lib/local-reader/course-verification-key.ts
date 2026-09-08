import { createHash } from "node:crypto";

export function createLocalReaderCourseVerificationKey(courseId: string, targetDate: string, players: number) {
  return createHash("sha256").update(
    ["local-reader-course-verification", courseId, targetDate, players].join("\n"),
  ).digest("hex");
}
