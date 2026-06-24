import { createApp } from './http/app';
import { config } from './config';

const app = createApp();
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`EMS server listening on http://localhost:${config.port}`);
  // eslint-disable-next-line no-console
  console.log(`UI:        http://localhost:${config.port}/`);
  // eslint-disable-next-line no-console
  console.log(`Health:    http://localhost:${config.port}/health`);
  // eslint-disable-next-line no-console
  console.log(`Metrics:   http://localhost:${config.port}/metrics`);
});
