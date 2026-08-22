import "./load-local-env";

import {
  buildCourseSupportAcceptanceReadFailureProjection,
  loadCourseSupportAcceptanceProjection,
} from "@/lib/operator/course-support-acceptance";
import {
  buildCourseSupportAcceptanceWorkerOutput,
  parseCourseSupportAcceptanceWorkerInput,
} from "@/lib/operator/course-support-acceptance-process";

const MAX_WORKER_INPUT_BYTES = 64 * 1024;

async function main() {
  const input = parseCourseSupportAcceptanceWorkerInput(
    JSON.parse(await readBoundedStandardInput()),
  );
  const projection = input
    ? await loadCourseSupportAcceptanceProjection(input)
    : buildCourseSupportAcceptanceReadFailureProjection();
  process.stdout.write(
    `${JSON.stringify(buildCourseSupportAcceptanceWorkerOutput(projection))}\n`,
  );
}

async function readBoundedStandardInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_WORKER_INPUT_BYTES) {
      throw new Error("Acceptance worker input exceeded its fixed bound.");
    }
  }
  return input;
}

main().catch(() => {
  process.stdout.write(
    `${JSON.stringify(
      buildCourseSupportAcceptanceWorkerOutput(
        buildCourseSupportAcceptanceReadFailureProjection(),
      ),
    )}\n`,
  );
});
