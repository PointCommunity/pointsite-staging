import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { expectedCandidateChecksum } from '../scripts/verify-staging.mts';

test('rejects a deliberately corrupted baseline checksum', async () => {
  const content = await readFile('content/builder-site.json', 'utf8');
  const manifest = JSON.parse(await readFile('content/builder-site.manifest.json', 'utf8')) as { rendererVersion: string; source: string; sha256: string };
  const observed = await expectedCandidateChecksum(content, manifest);
  assert.equal(observed, manifest.sha256);
  assert.notEqual(observed, '0'.repeat(64));
});
