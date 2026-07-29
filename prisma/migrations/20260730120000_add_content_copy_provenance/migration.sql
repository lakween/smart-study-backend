ALTER TABLE "subjects"
  ADD COLUMN "originalCreatorId" TEXT,
  ADD COLUMN "originalCreatorName" TEXT,
  ADD COLUMN "copiedFromId" TEXT;

ALTER TABLE "topics"
  ADD COLUMN "originalCreatorId" TEXT,
  ADD COLUMN "originalCreatorName" TEXT,
  ADD COLUMN "copiedFromId" TEXT;

ALTER TABLE "documents"
  ADD COLUMN "originalCreatorId" TEXT,
  ADD COLUMN "originalCreatorName" TEXT,
  ADD COLUMN "copiedFromId" TEXT;

ALTER TABLE "quizzes"
  ADD COLUMN "originalCreatorId" TEXT,
  ADD COLUMN "originalCreatorName" TEXT,
  ADD COLUMN "copiedFromId" TEXT;
