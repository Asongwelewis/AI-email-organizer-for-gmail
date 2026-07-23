import { existsSync, rmSync } from 'node:fs';

import husky from 'husky';

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
