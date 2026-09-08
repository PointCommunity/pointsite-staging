import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builder = resolve(root, '../pointsite-builder/src/site-kit');
const target = join(root, 'site-kit');
const files = [
  'SiteRenderer.tsx',
  'canonicalize.ts',
  'default-site.ts',
  'editable-header.ts',
  'editable-page-hero.ts',
  'grid-layout.ts',
  'linked-media.ts',
  'migrations.ts',
  'presets.ts',
  'registry.tsx',
  'schema.ts',
  'site.css',
  'tokens.ts',
  'types.ts',
  'url-policy.ts',
  'version.ts',
];

await mkdir(target, { recursive: true });
for (const file of files) await copyFile(join(builder, file), join(target, file));
const imported = await import(pathToFileURL(join(target, 'default-site.ts')).href);
const json = `${JSON.stringify(imported.defaultSiteDocument, null, 2)}\n`;
await writeFile(join(root, 'content/builder-site.json'), json);
await writeFile(join(root, 'content/builder-site.manifest.json'), `${JSON.stringify({ rendererVersion: imported.defaultSiteDocument.rendererVersion, sha256: createHash('sha256').update(json).digest('hex'), source: 'PointCommunity/pointsite-builder' }, null, 2)}\n`);
console.log(`Synced ${files.length} renderer files and canonical content.`);
