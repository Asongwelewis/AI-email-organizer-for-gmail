import { existsSync, rmSync } from 'node:fs';

/**
 * Installs the Git hooks, and does nothing at all where there are none to install.
 *
 * npm runs `prepare` after every install, including installs that omit dev dependencies — a Vercel
 * production build, `npm ci --omit=dev`, a production image. `husky` is a dev dependency, so a
 * static import here fails the whole install on a machine that was never going to commit anything.
 * That is what broke the production deploy: the build had no cache, npm installed without dev
 * dependencies, and `prepare` brought the install down with it.
 *
 * Resolving it dynamically turns "no hooks to install" into the no-op it should always have been.
 */
let husky;
try {
  ({ default: husky } = await import('husky'));
} catch {
  // Not a developer checkout. Hooks are a local convenience and there is nothing to do.
  process.exit(0);
}

const message = husky();

if (message) {
  console.log(message);
}

const prePushHook = new URL('./pre-push', import.meta.url);
const prePushShim = new URL('./_/pre-push', import.meta.url);

// GitHub Desktop on Windows can fail while invoking Husky's unused pre-push
// shim because the GUI cannot provide /dev/stdin. Keep the shim only when the
// project defines a real pre-push hook.
if (!existsSync(prePushHook)) {
  rmSync(prePushShim, { force: true });
}
