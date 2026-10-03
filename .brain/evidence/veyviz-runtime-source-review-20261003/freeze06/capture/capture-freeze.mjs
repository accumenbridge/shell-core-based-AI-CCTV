import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const active = resolve(process.argv[2]);
const overlay = resolve(process.argv[3]);
const evidence = resolve(process.argv[4]);
const previousDir = join(overlay, 'evidence', 'freeze-run-05');
const previous = JSON.parse(await readFile(join(previousDir, 'freeze.json'), 'utf8'));
const sourceOwners = ['tests/veyviz-snapshot.test.mjs'];
const owners = ['package.json', 'tools/veyviz-build.mjs', 'tools/veyviz-inventory.mjs', 'tools/veyviz-start.mjs', 'tools/veyviz-snapshot.mjs', 'tests/veyviz-lifecycle.test.mjs', 'tests/veyviz-snapshot.test.mjs'];
const activeApi = await import(pathToFileURL(join(active, 'tools/veyviz-inventory.mjs')).href);
const overlayApi = await import(pathToFileURL(join(overlay, 'tools/veyviz-inventory.mjs')).href);
const capture = async (api, root) => ({ source: await api.captureAuthoredBuildInputs(root), toolchain: await api.captureBuildToolchain(root) });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const writeJson = async (name, value) => {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  await writeFile(join(evidence, name), bytes, { flag: 'wx' });
  return { path: join(evidence, name), bytes: bytes.length, sha256: hash(bytes) };
};
const fileMap = (manifest) => new Map(manifest.files.map((item) => [item.path, item]));
const changedPaths = (before, after) => {
  const a = fileMap(before); const b = fileMap(after);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((path) => {
    const left = a.get(path); const right = b.get(path);
    return !left || !right || left.bytes !== right.bytes || left.sha256 !== right.sha256;
  });
};
const priorSource = JSON.parse(await readFile(join(previousDir, 'source-overlay.json'), 'utf8'));
const priorToolchain = JSON.parse(await readFile(join(previousDir, 'toolchain-overlay.json'), 'utf8'));
if (priorSource.digest !== previous.candidate.sourceDigest || priorToolchain.digest !== previous.candidate.toolchainDigest) throw new Error('Freeze05 manifest digest mismatch.');
const [activeBefore, overlayNow] = await Promise.all([capture(activeApi, active), capture(overlayApi, overlay)]);
if (!same(overlayNow.toolchain, priorToolchain)) throw new Error('Toolchain changed from freeze05; refusing to proceed.');
const overlayDelta = changedPaths(priorSource, overlayNow.source);
if (!same(overlayDelta, sourceOwners)) throw new Error('Overlay changed outside the one admitted fixture owner: ' + overlayDelta.join(', '));
for (const path of owners) {
  const a = fileMap(activeBefore.source).get(path);
  const o = fileMap(overlayNow.source).get(path);
  if (!a || !o || a.sha256 !== o.sha256 || a.bytes !== o.bytes) throw new Error('An admitted owner differs between active and overlay: ' + path);
}
if (activeBefore.toolchain.digest !== priorToolchain.digest) throw new Error('Active toolchain drifted from freeze05.');
const [activeAfter, overlayAfter] = await Promise.all([capture(activeApi, active), capture(overlayApi, overlay)]);
if (!same(activeBefore.source, activeAfter.source) || !same(activeBefore.toolchain, activeAfter.toolchain)) throw new Error('Active source/toolchain changed during freeze capture.');
if (!same(overlayNow.source, overlayAfter.source) || !same(overlayNow.toolchain, overlayAfter.toolchain)) throw new Error('Overlay changed during freeze capture.');
const overlaySourceDelta = changedPaths(priorSource, overlayAfter.source);
if (!same(overlaySourceDelta, sourceOwners)) throw new Error('Candidate delta is not the one admitted fixture file.');
const sourceMap = fileMap(overlayAfter.source);
const ownerHashes = Object.fromEntries(owners.map((path) => {
  const item = sourceMap.get(path);
  if (!item) throw new Error('Missing admitted owner: ' + path);
  return [path, item.sha256];
}));
const activeDelta = changedPaths(priorSource, activeAfter.source);
const activeOverlayDelta = changedPaths(overlayAfter.source, activeAfter.source);
const evidenceFiles = {};
evidenceFiles['source-overlay.json'] = await writeJson('source-overlay.json', overlayAfter.source);
evidenceFiles['toolchain-overlay.json'] = await writeJson('toolchain-overlay.json', overlayAfter.toolchain);
evidenceFiles['source-active-observed.json'] = await writeJson('source-active-observed.json', activeAfter.source);
evidenceFiles['toolchain-active-observed.json'] = await writeJson('toolchain-active-observed.json', activeAfter.toolchain);
const frozen = {
  schema: 'veyviz.isolated-source-freeze.v2',
  candidate: { activeRoot: active, overlayRoot: overlay, evidenceRoot: evidence, sourceDigest: overlayAfter.source.digest, toolchainDigest: overlayAfter.toolchain.digest, sourceFiles: overlayAfter.source.files.length },
  copiedDeltaSinceFreeze05: sourceOwners.map((path) => ({ path, previousSha256: fileMap(priorSource).get(path)?.sha256 ?? null, candidateSha256: sourceMap.get(path).sha256 })),
  ownerHashes,
  toolPackages: previous.toolPackages,
  activeComparison: { sourceDigest: activeAfter.source.digest, toolchainDigest: activeAfter.toolchain.digest, changedFromFreeze05: activeDelta, activeVsOverlay: activeOverlayDelta, copiedPaths: sourceOwners, copiedOnlyAdmittedPaths: same(overlaySourceDelta, sourceOwners), toolchainMatchesCandidate: activeAfter.toolchain.digest === overlayAfter.toolchain.digest },
  evidenceFiles,
  capturedAt: new Date().toISOString()
};
const frozenBytes = Buffer.from(JSON.stringify(frozen, null, 2) + '\n', 'utf8');
await writeFile(join(evidence, 'freeze.json'), frozenBytes, { flag: 'wx' });
console.log(JSON.stringify({ evidenceRoot: evidence, freezeSha256: hash(frozenBytes), sourceDigest: overlayAfter.source.digest, toolchainDigest: overlayAfter.toolchain.digest, sourceFiles: overlayAfter.source.files.length, copiedDelta: overlaySourceDelta, activeChangedFromFreeze05: activeDelta, activeVsOverlay: activeOverlayDelta, ownerHashes, evidenceFiles }, null, 2));
