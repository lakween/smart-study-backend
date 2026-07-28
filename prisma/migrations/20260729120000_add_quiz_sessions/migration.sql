CREATE TYPE "QuizPracticeMode" AS ENUM ('TIMED', 'UNTIMED');

CREATE TABLE "quiz_sessions" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "QuizPracticeMode" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "quiz_sessions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "quiz_attempts" ADD COLUMN "sessionId" TEXT;

CREATE UNIQUE INDEX "quiz_attempts_sessionId_key" ON "quiz_attempts"("sessionId");
CREATE INDEX "quiz_attempts_userId_attemptedAt_idx" ON "quiz_attempts"("userId", "attemptedAt");
CREATE INDEX "quiz_attempts_quizId_userId_idx" ON "quiz_attempts"("quizId", "userId");
CREATE INDEX "quiz_sessions_userId_quizId_startedAt_idx" ON "quiz_sessions"("userId", "quizId", "startedAt");
CREATE INDEX "quiz_sessions_deadlineAt_idx" ON "quiz_sessions"("deadlineAt");

ALTER TABLE "quiz_sessions" ADD CONSTRAINT "quiz_sessions_quizId_fkey"
  FOREIGN KEY ("quizId") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quiz_sessions" ADD CONSTRAINT "quiz_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "quiz_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

