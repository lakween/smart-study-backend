-- Production exam lifecycle additions. This migration is additive and keeps
-- existing exams and participant results intact.
CREATE TYPE "ExamInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');
CREATE TYPE "ExamAttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED');
CREATE TYPE "ExamResultRelease" AS ENUM ('AFTER_SUBMISSION', 'AFTER_CLOSE');

ALTER TABLE "exams"
  ADD COLUMN "closesAt" TIMESTAMP(3),
  ADD COLUMN "questionCount" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "passPercent" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "shuffleQuestions" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "resultRelease" "ExamResultRelease" NOT NULL DEFAULT 'AFTER_SUBMISSION',
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "exams"
SET "publishedAt" = "createdAt",
    "closesAt" = CASE
      WHEN "startTime" IS NULL THEN NULL
      ELSE "startTime" + ("durationMinutes" * INTERVAL '1 minute')
    END,
    "resultRelease" = CASE
      WHEN "type" = 'FRIEND_EXAM' THEN 'AFTER_CLOSE'::"ExamResultRelease"
      ELSE 'AFTER_SUBMISSION'::"ExamResultRelease"
    END
WHERE "status" <> 'DRAFT';

CREATE TABLE "exam_invitations" (
  "id" TEXT NOT NULL,
  "examId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "ExamInvitationStatus" NOT NULL DEFAULT 'PENDING',
  "respondedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "exam_invitations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exam_attempts" (
  "id" TEXT NOT NULL,
  "examId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "ExamAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "scorePercent" DOUBLE PRECISION,
  "correctCount" INTEGER,
  "totalQuestions" INTEGER NOT NULL,
  "questionOrder" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "exam_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exam_answers" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "selectedAnswer" "AnswerOption",
  "savedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "exam_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exam_invitations_examId_userId_key" ON "exam_invitations"("examId", "userId");
CREATE INDEX "exam_invitations_userId_status_createdAt_idx" ON "exam_invitations"("userId", "status", "createdAt");
CREATE UNIQUE INDEX "exam_attempts_examId_userId_key" ON "exam_attempts"("examId", "userId");
CREATE INDEX "exam_attempts_userId_status_startedAt_idx" ON "exam_attempts"("userId", "status", "startedAt");
CREATE INDEX "exam_attempts_deadlineAt_status_idx" ON "exam_attempts"("deadlineAt", "status");
CREATE UNIQUE INDEX "exam_answers_attemptId_questionId_key" ON "exam_answers"("attemptId", "questionId");
CREATE INDEX "exams_status_startTime_idx" ON "exams"("status", "startTime");
CREATE INDEX "exams_closesAt_idx" ON "exams"("closesAt");

ALTER TABLE "exam_invitations" ADD CONSTRAINT "exam_invitations_examId_fkey"
  FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exam_invitations" ADD CONSTRAINT "exam_invitations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_examId_fkey"
  FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "exam_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "exam_invitations" ("id", "examId", "userId", "status", "respondedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, p."examId", p."userId", 'ACCEPTED', p."invitedAt", p."invitedAt", CURRENT_TIMESTAMP
FROM "exam_participants" p
JOIN "exams" e ON e."id" = p."examId"
WHERE p."userId" <> e."organizerId"
ON CONFLICT ("examId", "userId") DO NOTHING;
