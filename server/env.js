import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load configuration before any database or integration module reads it.
// Values supplied by the process manager take precedence over the file.
export function loadEnvironment(filename = process.env.ECHO_ENV_FILE || fileURLToPath(new URL('../.env', import.meta.url))) {
  if (!fs.existsSync(filename)) return;
  if (typeof process.loadEnvFile !== 'function') throw new Error('读取 .env 需要 Node.js 22 或更高版本');
  process.loadEnvFile(filename);
}

loadEnvironment();
