ALTER TABLE "CoursePreference"
ADD COLUMN "distanceMetersAtSelection" INTEGER;

ALTER TABLE "CoursePreference"
ADD CONSTRAINT "CoursePreference_distanceMetersAtSelection_check"
CHECK (
  "distanceMetersAtSelection" IS NULL
  OR (
    "distanceMetersAtSelection" >= 0
    AND "distanceMetersAtSelection" <= 200000
  )
);
