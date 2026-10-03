import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const active = resolve(process.argv[2]);
const overlay = resolve(process.argv[3]);
const evidence = resolve(process.argv[4]);
const previousDir = join(overlay, 'evidence', 'freeze-run-04');
const previous = JSON.parse(await readFile(join(previousDir, 'freeze.json'), 'utf8'));
const sourceOwners = ['tools/veyviz-snapshot.mjs', 'tests/veyviz-snapshot.test.mjs'];
const owners = [
  'package.json', 'tools/veyviz-build.mjs', 'tools/veyviz-inventory.mjs',
  'tools/veyviz-start.mjs', 'tools/veyviz-snapshot.mjs',
  'tests/veyviz-lifecycle.test.mjs', 'tests/veyviz-snapshot.test.mjs'
];
const activeApi = await import(pathToFileURL(join(active, 'tools/veyviz-inventory.mjs')).href);
const overlayApi = await import(pathToFileURL(join(overlay, 'tools/veyviz-inventory.mjs')).href);
const capture = async (api, root) => ({
  source: await api.captureAuthoredBuildInputs(root),
  toolchain: await api.captureBuildToolchain(root)
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeJson = async (name, value) => {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  await writeFile(join(evidence, name), bytes, { flag: 'wx' });
  return { path: join(evidence, name), bytes: bytes.length, sha256: hash(bytes) };
};
const mapFiles = (manifest) => new Map(manifest.files.map((item) => [item.path, item]));
const changedPaths = (before, after) => {
  const a = mapFiles(before); const b = mapFiles(after);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((path) => {
    const left = a.get(path); const right = b.get(path);
    return !left || !right || left.bytes !== right.bytes || left.sha256 !== right.sha256;
  });
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const priorSource = JSON.parse(await readFile(join(previousDir, 'source-overlay.json'), 'utf8'));
const priorToolchain = JSON.parse(await readFile(join(previousDir, 'toolchain-overlay.json'), 'utf8'));
if (priorSource.digest !== previous.candidate.sourceDigest || priorToolchain.digest !== previous.candidate.toolchainDigest) throw new Error('Freeze04 manifest digest mismatch.');
const [activeBefore, overlayBefore] = await Promise.all([capture(activeApi, active), capture(overlayApi, overlay)]);
if (!same(overlayBefore.source, priorSource) || !same(overlayBefore.toolchain, priorToolchain)) throw new Error('The existing isolated overlay no longer matches freeze04; refusing to refresh or overwrite it.');
if (activeBefore.toolchain.digest !== priorToolchain.digest) throw new Error('Active toolchain drifted from freeze04; do not copy it into the overlay.');
for (const path of sourceOwners) await copyFile(join(active, ...path.split('/')), join(overlay, ...path.split('/')));
const [activeAfter, overlayAfter] = await Promise.all([capture(activeApi, active), capture(overlayApi, overlay)]);
if (!same(activeBefore.source, activeAfter.source) || !same(activeBefore.toolchain, activeAfter.toolchain)) throw new Error('Active source/toolchain changed during freeze capture.');
if (!same(overlayAfter.toolchain, priorToolchain)) throw new Error('Overlay toolchain changed while copying the two repaired owners.');
const copiedDelta = changedPaths(priorSource, overlayAfter.source);
if (!same(copiedDelta, sourceOwners.slice().sort())) throw new Error('Candidate source delta is not exactly the two diagnosed owner files: ' + copiedDelta.join(', '));
const activeDelta = changedPaths(priorSource, activeAfter.source);
const sourceMap = mapFiles(overlayAfter.source);
const ownerHashes = Object.fromEntries(owners.map((path) => {
  const item = sourceMap.get(path);
  if (!item) throw new Error('Missing admitted owner from authored inventory: ' + path);
  return [path, item.sha256];
}));
const copiedBytes = sourceOwners.reduce((sum, path) => sum + sourceMap.get(path).bytes, 0);
const evidenceFiles = {};
evidenceFiles['source-overlay.json'] = await writeJson('source-overlay.json', overlayAfter.source);
evidenceFiles['toolchain-overlay.json'] = await writeJson('toolchain-overlay.json', overlayAfter.toolchain);
evidenceFiles['source-active-observed.json'] = await writeJson('source-active-observed.json', activeAfter.source);
evidenceFiles['toolchain-active-observed.json'] = await writeJson('toolchain-active-observed.json', activeAfter.toolchain);
const frozen = {
  schema: 'veyviz.isolated-source-freeze.v2',
  candidate: {
    activeRoot: active,
    overlayRoot: overlay,
    evidenceRoot: evidence,
    sourceDigest: overlayAfter.source.digest,
    toolchainDigest: overlayAfter.toolchain.digest,
    sourceFiles: overlayAfter.source.files.length
  },
  copiedDeltaSinceFreeze04: sourceOwners.map((path) => ({
    path,
    previousSha256: mapFiles(priorSource).get(path)?.sha256 ?? null,
    candidateSha256: sourceMap.get(path).sha256
  })),
  ownerHashes,
  toolPackages: previous.toolPackages,
  activeComparison: {
    sourceDigest: activeAfter.source.digest,
    toolchainDigest: activeAfter.toolchain.digest,
    changedFromFreeze04: activeDelta,
    copiedPaths: sourceOwners,
    copiedOnlyAdmittedPaths: same(copiedDelta, sourceOwners.slice().sort()),
    toolchainMatchesCandidate: activeAfter.toolchain.digest === overlayAfter.toolchain.digest
  },
  evidenceFiles,
  sourceBytesCopied: copiedBytes,
  capturedAt: new Date().toISOString()
};
const frozenBytes = Buffer.from(JSON.stringify(frozen, null, 2) + '\n', 'utf8');
await writeFile(join(evidence, 'freeze.json'), frozenBytes, { flag: 'wx' });
console.log(JSON.stringify({
  evidenceRoot: evidence,
  freezeSha256: hash(frozenBytes),
  sourceDigest: overlayAfter.source.digest,
  toolchainDigest: overlayAfter.toolchain.digest,
  sourceFiles: overlayAfter.source.files.length,
  copiedDelta,
  activeChangedFromFreeze04: activeDelta,
  ownerHashes,
  evidenceFiles
}, null, 2));
