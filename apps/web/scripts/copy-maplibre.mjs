// Serves MapLibre's worker from our own origin (CSP worker-src 'self'; D-174). MapLibre 6 resolves its worker
// relative to its own module URL, which bundling breaks, so the app points setWorkerUrl at these copies.
// Runs before dev and build; the output is generated, not committed (.gitignore).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor', 'maplibre');
mkdirSync(out, { recursive: true });
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'])
  copyFileSync(join(dist, file), join(out, file));
