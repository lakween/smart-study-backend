import { createServer } from 'http';

import { app } from './app';
import { env } from './config/env';
import { initializeSocket } from './realtime/socket';
import { startRevisionReminderScheduler } from './services/revision-reminder.service';
import { startExamLifecycleScheduler } from './services/exam-lifecycle.service';

const httpServer = createServer(app);
initializeSocket(httpServer);

httpServer.listen(env.port, () => {
  console.log(`Smart Study API listening on http://localhost:${env.port}`);
  const aiModel =
    env.aiProvider === 'openai' ? env.openAiModel : env.geminiModel;
  console.log(`AI quiz provider: ${env.aiProvider} (${aiModel})`);
  startRevisionReminderScheduler();
  startExamLifecycleScheduler();
});
