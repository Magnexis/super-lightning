import { loadConfig } from './config.js';
import { createLightningServer } from './server.js';

const configIndex = process.argv.indexOf('--config');
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : './super-lightning.config.json';
if (!configPath) throw new Error('Usage: super-lightning --config <path>');

try {
  const config = await loadConfig(configPath);
  const server = createLightningServer(config);
  server.listen(config.port, () => console.log(`Super Lightning listening on http://127.0.0.1:${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
} catch (error) {
  console.error(`Super Lightning could not start: ${error.message}`);
  process.exitCode = 1;
}
