import { createServer } from 'http';

import { app } from './app';
import { env } from './config/env';
import { initializeSocket } from './realtime/socket';

const httpServer = createServer(app);
initializeSocket(httpServer);

httpServer.listen(env.port, () => {
  console.log(`Smart Study API listening on http://localhost:${env.port}`);
});
