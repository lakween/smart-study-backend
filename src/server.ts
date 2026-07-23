import { app } from './app';
import { env } from './config/env';

app.listen(env.port, () => {
  console.log(`Smart Study API listening on http://localhost:${env.port}`);
});
