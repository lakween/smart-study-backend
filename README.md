# Smart Study App — Backend

Node.js + Express + TypeScript + Prisma (PostgreSQL) API powering the Smart Study Flutter app. Socket.IO provides authenticated, real-time in-app notification delivery.

## 1. Get a free Postgres database (Neon)

1. Go to https://neon.tech and sign up (free tier).
2. Create a new project (any name/region).
3. On the project dashboard, copy the **connection string** (use the pooled connection, it looks like
   `postgresql://user:password@ep-xxxx.neon.tech/dbname?sslmode=require`).

## 2. Configure an AI provider (for AI Quiz Generation)

Choose OpenAI or Gemini through `AI_PROVIDER`. Create the corresponding key at
https://platform.openai.com/api-keys or https://aistudio.google.com/apikey.

## 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `DATABASE_URL` — the Neon connection string from step 1
- `JWT_SECRET` — any long random string (e.g. run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `AI_PROVIDER` — `openai` or `gemini`
- `OPENAI_API_KEY` / `OPENAI_MODEL` — OpenAI credentials and model
- `GEMINI_API_KEY` / `GEMINI_MODEL` — Gemini credentials and model

## 4. Install, migrate, seed

```bash
npm install
npx prisma migrate dev --name init
npm run seed
```

This creates all tables and seeds 3 demo users (all with password `password123`):
- `alex@example.com`
- `priya@example.com`
- `jordan@example.com`

## 5. Run the server

```bash
npm run dev
```

The API listens on `http://localhost:4000` (health check: `GET /health`).

## Project layout

```
src/
  server.ts              HTTP and Socket.IO server bootstrap
  config/env.ts          Environment variable loading/validation
  lib/prisma.ts          Shared Prisma client instance
  middleware/            auth (JWT), file upload (multer), error handling
  routes/                One file per resource (auth, users, subjects, topics,
                          documents, quizzes, aiQuiz, exams, friends,
                          notifications, dashboard)
  services/               ai.service.ts (OpenAI/Gemini), textExtract.service.ts (PDF)
                           notification.service.ts (persist + real-time emit)
  realtime/               authenticated Socket.IO rooms and event emission
  utils/                  jwt, mappers (enum <-> wire format), serializers
                          (DB row -> API DTO), spacedRepetition, userStats
prisma/
  schema.prisma           Full data model
  seed.ts                 Demo data matching the Flutter app's old mock data
uploads/                  Persisted document/avatar bytes; documents use an authorized file route
```

## API overview

All endpoints except `/health`, `/auth/register`, `/auth/login`, `/auth/refresh`,
`/auth/logout`, `/auth/forgot-password`, and `/auth/reset-password` require
`Authorization: Bearer <token>`.

- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/logout`, `GET /auth/me`
- `POST /auth/forgot-password`, `POST /auth/reset-password`
- `PATCH /users/me`, `POST /users/me/avatar`, `POST /users/me/change-password`,
  `POST /users/me/change-email`, `DELETE /users/me`, `GET /users/:userId/profile`
- `GET/POST /subjects`, `GET/PATCH/DELETE /subjects/:id`
- `GET/POST /topics?subjectId=`, `GET/PATCH/DELETE /topics/:id`
- `GET/POST /documents?subjectId=&topicId=`, `PATCH/DELETE /documents/:id`, `POST /documents/:id/copy`
- `GET/POST /quizzes?filter=mine|friends|public|ai&subjectId=&topicId=`, `GET/PATCH/DELETE /quizzes/:id`
- `POST /quizzes/:id/attempts`, `GET /quizzes/:id/attempts/:attemptId`
- `POST /ai-quiz/generate` (multipart file + questionCount) → returns AI-generated questions to review
- `GET/POST /exams?tab=mine|invited`, `GET/PATCH/DELETE /exams/:id`, `POST /exams/:id/publish`, `POST /exams/:id/cancel`
- `POST /exams/:id/invitations/respond`, `POST /exams/:id/attempts`, `PUT /exams/:id/attempts/:attemptId/answers`, `POST /exams/:id/attempts/:attemptId/submit`, `GET /exams/:id/results`
- `GET /friends`, `GET /friends/search?q=`, `GET /friends/requests`,
  `POST /friends/request/:userId`, `POST /friends/accept/:userId`, `POST /friends/decline/:userId`,
  `DELETE /friends/request/:userId`, `DELETE /friends/:userId`
- `GET/POST /notifications`, `POST /notifications/read-all`, `POST /notifications/:id/read`, `DELETE /notifications/:id`
- `GET /dashboard/home`, `GET /dashboard/performance?period=week|month|all` (comparison, dated consistency/streaks, memory stages, rankings, revision actions, and submitted exam history)

## Real-time in-app notifications

The REST notification endpoints remain the source for initial history, read
state, deletion, and manual refresh. After authentication, the Flutter app also
opens a Socket.IO connection using the JWT in `auth.token`.

The server verifies the token, joins the socket to the private room
`user:<userId>`, and emits `notification:new` after the notification record is
stored. Friend requests and acceptances, exam invitations, quiz completion,
and AI quiz generation use this shared notification service. Exam lifecycle
changes also emit `exam:changed`, allowing open clients to refresh exam state.

Published exams snapshot topic questions and never expose correct answers in
attempt payloads. The server owns deadlines, autosaved answers, scoring, and
result release. A restart-safe 30-second lifecycle scan auto-submits overdue
attempts, expires unanswered invitations, closes exams, and emits durable
result notifications.

This is foreground in-app delivery, not operating-system push. It updates an
open app without polling or restarting, but it cannot notify a closed app.

When the public REST API uses the `/smart-study` prefix, configure the client
and reverse proxy to use the Socket.IO path `/smart-study/socket.io`. The Nginx
upgrade-header example is included in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Production deployment

Pushes to `main` are validated and deployed by `.github/workflows/deploy.yml`.
The workflow uses versioned releases, shared `.env` and uploads, Prisma
migrations, systemd restart, a health check, and application rollback. Follow
[`DEPLOYMENT.md`](DEPLOYMENT.md) before enabling the workflow on an Ubuntu
server.

## How spaced repetition works

Smart Study schedules quiz revisions so learners review material more often when
their recall is weak and less often as their recall improves.

The scheduling algorithm runs after every successful
`POST /quizzes/:id/attempts` submission:

1. The backend calculates the quiz score.
2. It reads the user's existing `SpacedRepetition` record for that quiz.
3. `computeNextRevision()` selects the next interval from
   `[1, 3, 7, 14, 30]` days.
4. The backend creates or updates the record with `lastScore`, `intervalDays`,
   and `nextRevisionDate`.
5. Dashboard and topic APIs return the calculated date to the Flutter app.

The pass threshold is 60 percent:

| Result | Next interval |
|---|---|
| First attempt scoring 60% or higher | 1 day |
| Another passing attempt | Advance to 3, 7, 14, then 30 days |
| Score below 60% | Reset to 1 day |
| Passing after reaching 30 days | Remain at 30 days |

Example:

```text
75% -> revise in 1 day
80% -> revise in 3 days
90% -> revise in 7 days
45% -> reset and revise in 1 day
```

Implementation and consumers:

- Algorithm: `src/utils/spacedRepetition.ts`
- Attempt integration: `src/routes/quizzes.routes.ts`
- Database record: `SpacedRepetition` in `prisma/schema.prisma`
- Home memory summary and revision queue: `GET /dashboard/home` returns due-now, next-three-day, and active-plan counts plus each queued quiz's current interval, last score, and next revision date.
- Performance analytics: `GET /dashboard/performance?period=week|month|all`
  returns equal-period comparison, real completion-dated consistency/streaks,
  stored memory stages, actionable reviews, rankings, recommendations, and
  submitted exam history.
- Topic revision summary: `GET /topics?subjectId=...`

The Flutter app displays this information on the home dashboard, performance
dashboard, topic details, and topic cards. The current Settings switch labelled
"Spaced Repetition" is UI-only; turning it off does not yet disable backend
scheduling.

## Notes

- Spaced repetition: after each quiz attempt, `intervalDays` moves up the ladder `[1, 3, 7, 14, 30]`
  on a pass (≥60%) or resets to `1` on a fail, and `nextRevisionDate` is recalculated (`src/utils/spacedRepetition.ts`).
- Visibility rules (`private`/`friendsOnly`/`public`) are enforced server-side for subjects, topics,
  documents and quizzes via `visibleToViewer()` in `src/routes/friends.routes.ts`.
- Password reset has no email provider wired up — the reset token is logged to the server console and
  echoed in the API response outside of `NODE_ENV=production`, so the Flutter app can complete the flow
  without a real mailbox.
