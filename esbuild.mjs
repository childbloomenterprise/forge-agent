import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, external: ['vscode'] };

if (tests) {
  const entryPoints = fs.readdirSync('test').filter((f) => f.endsWith('.ts')).map((f) => `test/${f}`);
  await esbuild.build({ ...common, entryPoints, outdir: 'out/test', format: 'esm', outExtension: { '.js': '.mjs' }, banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
} else {
  const ctx = await esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', minify: !watch });
  if (watch) await ctx.watch();
  else { await ctx.rebuild(); await ctx.dispose(); }
}
