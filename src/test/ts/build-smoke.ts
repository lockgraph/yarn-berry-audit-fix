import { copyFile, cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
await mkdir('target/smoke-managers', { recursive: true });
for (const alias of ['pm-yarn-2', 'pm-yarn-berry-v6', 'pm-yarn-berry-v10']) {
  await copyFile(require.resolve(`${alias}/bin/yarn.js`), resolve('target/smoke-managers', `${alias}.cjs`));
}
await cp('src/test/resources/real-world', 'target/smoke/test/resources/real-world', { recursive: true });
console.log('Prepared compiled smoke tests, fixture assets, and standalone Yarn bundles');
