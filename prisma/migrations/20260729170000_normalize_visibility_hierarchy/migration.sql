-- Repair legacy rows created before parent/child visibility was enforced.
UPDATE "topics" AS topic SET "visibility" = 'PRIVATE'
FROM "subjects" AS subject
WHERE topic."subjectId" = subject."id" AND subject."visibility" = 'PRIVATE' AND topic."visibility" <> 'PRIVATE';

UPDATE "topics" AS topic SET "visibility" = 'FRIENDS_ONLY'
FROM "subjects" AS subject
WHERE topic."subjectId" = subject."id" AND subject."visibility" = 'FRIENDS_ONLY' AND topic."visibility" = 'PUBLIC';

UPDATE "quizzes" AS quiz SET "visibility" = 'PRIVATE'
FROM "subjects" AS subject, "topics" AS topic
WHERE quiz."subjectId" = subject."id" AND quiz."topicId" = topic."id"
  AND (subject."visibility" = 'PRIVATE' OR topic."visibility" = 'PRIVATE') AND quiz."visibility" <> 'PRIVATE';

UPDATE "quizzes" AS quiz SET "visibility" = 'FRIENDS_ONLY'
FROM "subjects" AS subject, "topics" AS topic
WHERE quiz."subjectId" = subject."id" AND quiz."topicId" = topic."id"
  AND subject."visibility" <> 'PRIVATE' AND topic."visibility" <> 'PRIVATE'
  AND (subject."visibility" = 'FRIENDS_ONLY' OR topic."visibility" = 'FRIENDS_ONLY') AND quiz."visibility" = 'PUBLIC';

UPDATE "documents" AS document SET "visibility" = 'PRIVATE'
FROM "subjects" AS subject
WHERE document."subjectId" = subject."id" AND subject."visibility" = 'PRIVATE' AND document."visibility" <> 'PRIVATE';

UPDATE "documents" AS document SET "visibility" = 'PRIVATE'
FROM "topics" AS topic
WHERE document."topicId" = topic."id" AND topic."visibility" = 'PRIVATE' AND document."visibility" <> 'PRIVATE';

UPDATE "documents" AS document SET "visibility" = 'FRIENDS_ONLY'
FROM "subjects" AS subject
WHERE document."subjectId" = subject."id" AND subject."visibility" = 'FRIENDS_ONLY' AND document."visibility" = 'PUBLIC';

UPDATE "documents" AS document SET "visibility" = 'FRIENDS_ONLY'
FROM "topics" AS topic
WHERE document."topicId" = topic."id" AND topic."visibility" = 'FRIENDS_ONLY' AND document."visibility" = 'PUBLIC';
