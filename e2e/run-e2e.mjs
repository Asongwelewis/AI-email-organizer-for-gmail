import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const viteConfig = fileURLToPath(new URL('../apps/web/vite.config.ts', import.meta.url));
const playwrightCli = fileURLToPath(
  new URL('../node_modules/@playwright/test/cli.js', import.meta.url),
);

process.env.VITE_API_BASE_URL = 'http://127.0.0.1:4174';

const server = await createServer({
  root: webRoot,
  configFile: viteConfig,
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
});

try {
  await server.listen();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, 'test', '--config', 'playwright.config.mjs'],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await server.close();
}
