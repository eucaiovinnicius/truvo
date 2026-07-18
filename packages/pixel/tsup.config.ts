import { defineConfig } from 'tsup';

/**
 * Bundle do pixel. Alvo: < 5kb (min + gzip).
 *  - iife  → dist/pixel.js  (arquivo servido como /pixel.js; auto-executa, seta window.truvo)
 *  - esm   → dist/pixel.mjs (para quem quiser importar via bundler)
 */
export default defineConfig({
  entry: { pixel: 'src/index.ts' },
  format: ['iife', 'esm'],
  globalName: 'TruvoPixel',
  platform: 'browser',
  target: 'es2019',
  minify: true,
  treeshake: true,
  clean: true,
  sourcemap: false,
  dts: true,
  outExtension({ format }) {
    return { js: format === 'iife' ? '.js' : '.mjs' };
  },
});
