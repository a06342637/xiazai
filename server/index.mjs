import path from 'node:path';
import { createApp } from './app.mjs';

const runtime = await createApp({ dataDir: process.env.DATA_DIR || path.resolve('data'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin', adminPassword: process.env.ADMIN_PASSWORD, publicUrl: process.env.PUBLIC_URL || '',
  updaterUrl: process.env.UPDATER_URL, updateKey: process.env.UPDATE_KEY });
const server = runtime.app.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log(`xiazai v${runtime.version} listening on ${server.address().port}`));
// Large streamed uploads have no fixed total time limit. Idle sockets still time out.
server.requestTimeout = 0; server.headersTimeout = 60000; server.setTimeout(120000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  runtime.close(); server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 25000).unref();
});
