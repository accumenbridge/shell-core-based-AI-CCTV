import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const evidenceDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const before = JSON.parse(await readFile(join(evidenceDir, 'overlay-before-fresh-build-inventory.json'), 'utf8'));
const after = JSON.parse(await readFile(join(evidenceDir, 'overlay-after-focused-tests-inventory.json'), 'utf8'));
const ownerPathDifferences = before.ownerPathHashes.flatMap((row, index) => {
  const later = after.ownerPathHashes[index];
  return !later || row.path !== later.path || row.bytes !== later.bytes || row.sha256 !== later.sha256 ? [{ before: row, after: later ?? null }] : [];
});
const result = {
  schema: 'veyviz.product-paging-reviewer-overlay-inventory-comparison.v1',
  comparedUtc: new Date().toISOString(),
  candidateIdentity: before.candidateIdentity,
  beforePhase: before.phase,
  afterPhase: after.phase,
  maintainedDigestStable: before.maintainedDigest === after.maintainedDigest,
  maintainedCountStable: before.maintainedFileCount === after.maintainedFileCount,
  ownerPathCount: before.ownerPathHashes.length,
  ownerPathHashesStable: ownerPathDifferences.length === 0,
  ownerPathDifferences,
  beforeMaintainedDigest: before.maintainedDigest,
  afterMaintainedDigest: after.maintainedDigest,
  beforeOwnerPathHashes: before.ownerPathHashes,
  afterOwnerPathHashes: after.ownerPathHashes
};
if (!result.maintainedDigestStable || !result.maintainedCountStable || !result.ownerPathHashesStable) throw new Error(JSON.stringify(result));
const path = join(evidenceDir, 'overlay-build-test-source-comparison.json');
await writeFile(path, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ candidateIdentity: result.candidateIdentity, maintainedDigestStable: result.maintainedDigestStable, maintainedCountStable: result.maintainedCountStable, ownerPathCount: result.ownerPathCount, ownerPathHashesStable: result.ownerPathHashesStable, outputPath: path }) + '\n');
