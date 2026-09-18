import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const shared = resolve(root, 'extension/shared');
const sources = { chromium: resolve(root, 'extension/chromium'), firefox: resolve(root, 'extension/firefox') };
const outputs = { chromium: resolve(root, 'dist/chromium-extension'), firefox: resolve(root, 'dist/firefox-extension') };
const staticFiles = ['app.html', 'app.css', 'assets'];

for (const browser of Object.keys(outputs) as (keyof typeof outputs)[]) {
  const out = outputs[browser];
  await rm(out, { recursive: true, force: true });
  await mkdir(resolve(out, 'dist'), { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(shared, 'src/background.ts'), resolve(shared, 'src/app.ts')],
    outdir: resolve(out, 'dist'),
    target: 'browser',
  });
  if (!result.success) throw new AggregateError(result.logs, `Extension build failed for ${browser}.`);
  await cp(resolve(sources[browser], 'manifest.json'), resolve(out, 'manifest.json'));
  for (const file of staticFiles) await cp(resolve(shared, file), resolve(out, file), { recursive: true });
}
console.log('Built Chromium dist/chromium-extension/ and Firefox dist/firefox-extension/.');

if (process.argv.includes('--package')) {
  for (const [cwd, name] of [[outputs.chromium, 'browspark-extension.zip'], [outputs.firefox, 'browspark-firefox-extension.zip']] as const) {
    const archive = resolve(root, 'dist', name);
    await rm(archive, { force: true });
    const child = Bun.spawn(['zip', '-qr', archive, 'manifest.json', ...staticFiles, 'dist'], { cwd, stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error(`Packaging ${name} failed.`);
    console.log(`Packaged dist/${name}`);
  }
}
