// @vitest-environment node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const container = process.env.COURSE_SUPPORT_SCHEMA_TEST_CONTAINER;
const database = process.env.COURSE_SUPPORT_SCHEMA_TEST_DATABASE;
const role = process.env.COURSE_SUPPORT_SCHEMA_TEST_ROLE ?? "postgres";

describe.skipIf(!container || !database)("assigned batch uniqueness migration in isolated Postgres", () => {
  it("preserves active rows, legacy uniqueness and global course uniqueness while admitting distinct assigned courses", () => {
    if (!/^[a-z0-9_-]+$/iu.test(container!) || !/^course_worker_uniqueness_[a-z0-9_]+$/u.test(database!) || !/^[a-z0-9_]+$/iu.test(role)) {
      throw new Error("Explicit isolated local test container/database required.");
    }
    const schema = `batch_uniqueness_${randomUUID().replaceAll("-", "")}`;
    const execute = (sql: string) => {
      const result = spawnSync("docker", ["exec", "-i", container!, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", role, "-d", database!],
        { input: sql, encoding: "utf8", windowsHide: true, timeout: 45_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    let owned = false;
    try {
      execute(`CREATE SCHEMA "${schema}";`); owned = true;
      const migration = readFileSync(resolve("prisma/migrations/20261029214000_align_assigned_course_batch_uniqueness/migration.sql"), "utf8");
      execute(`SET search_path TO "${schema}";
        CREATE TYPE "CourseSupportBatchStatus" AS ENUM ('CLAIMED','IMPLEMENTING','VERIFYING','COMPLETED');
        CREATE TABLE "CourseSupportBatch" (id text PRIMARY KEY, "providerFamilyKey" text NOT NULL, "failureFingerprint" text NOT NULL,
          status "CourseSupportBatchStatus" NOT NULL, summary jsonb);
        CREATE UNIQUE INDEX "CourseSupportBatch_active_family_fingerprint_key" ON "CourseSupportBatch" ("providerFamilyKey","failureFingerprint")
          WHERE status IN ('CLAIMED','IMPLEMENTING','VERIFYING');
        INSERT INTO "CourseSupportBatch" VALUES ('existing','legacy','failure','VERIFYING',NULL);
        ${migration}
        DO $$ DECLARE assigned jsonb; BEGIN
          IF (SELECT count(*) FROM "CourseSupportBatch" WHERE id='existing' AND status='VERIFYING') <> 1 THEN RAISE EXCEPTION 'active row changed'; END IF;
          assigned := jsonb_build_object('dispatchAssignmentRef','course-assignment-11111111-1111-4111-8111-111111111111','dispatchCourseDigest',repeat('a',64));
          INSERT INTO "CourseSupportBatch" VALUES ('a','provider','same','CLAIMED',assigned);
          INSERT INTO "CourseSupportBatch" VALUES ('b','provider','same','CLAIMED',jsonb_set(assigned,'{dispatchCourseDigest}',to_jsonb(repeat('b',64))));
          BEGIN
            INSERT INTO "CourseSupportBatch" VALUES ('duplicate-course','different-provider','different-failure','IMPLEMENTING',assigned);
            RAISE EXCEPTION 'duplicate assigned course admitted';
          EXCEPTION WHEN unique_violation THEN NULL; END;
          BEGIN
            INSERT INTO "CourseSupportBatch" VALUES ('duplicate-legacy','legacy','failure','CLAIMED',NULL);
            RAISE EXCEPTION 'duplicate legacy group admitted';
          EXCEPTION WHEN unique_violation THEN NULL; END;
          BEGIN
            INSERT INTO "CourseSupportBatch" VALUES ('malformed','legacy','failure','CLAIMED',jsonb_set(assigned,'{dispatchAssignmentRef}','"invalid"'));
            RAISE EXCEPTION 'malformed proof bypassed legacy guard';
          EXCEPTION WHEN unique_violation THEN NULL; END;
          UPDATE "CourseSupportBatch" SET status='COMPLETED' WHERE id='a';
          INSERT INTO "CourseSupportBatch" VALUES ('next-course-attempt','provider','same','VERIFYING',assigned);
          IF (SELECT count(*) FROM "CourseSupportBatch") <> 4 THEN RAISE EXCEPTION 'unexpected fixture rows'; END IF;
        END $$;`);
    } finally { if (owned) execute(`DROP SCHEMA "${schema}" CASCADE;`); }
  }, 60_000);
});
