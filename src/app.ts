import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { UPLOAD_DIR } from './middleware/upload.middleware';
import { requestContext } from './middleware/request.middleware';
import { rateLimit } from './middleware/rateLimit.middleware';

import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import subjectsRoutes from './routes/subjects.routes';
import topicsRoutes from './routes/topics.routes';
import documentsRoutes from './routes/documents.routes';
import quizzesRoutes from './routes/quizzes.routes';
import aiQuizRoutes from './routes/aiQuiz.routes';
import examsRoutes from './routes/exams.routes';
import friendsRoutes from './routes/friends.routes';
import notificationsRoutes from './routes/notifications.routes';
import dashboardRoutes from './routes/dashboard.routes';

export const app = express();

const allowedOrigins = env.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));
app.use(requestContext);
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/auth', rateLimit({ windowMs: 60_000, maxRequests: 30, scope: 'auth' }), authRoutes);
app.use('/users', usersRoutes);
app.use('/subjects', subjectsRoutes);
app.use('/topics', topicsRoutes);
app.use('/documents', documentsRoutes);
app.use('/quizzes', quizzesRoutes);
app.use('/ai-quiz', rateLimit({ windowMs: 60_000, maxRequests: 10, scope: 'ai-quiz' }), aiQuizRoutes);
app.use('/exams', examsRoutes);
app.use('/friends', friendsRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/dashboard', dashboardRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
