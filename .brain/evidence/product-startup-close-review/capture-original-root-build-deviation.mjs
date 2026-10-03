import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintainedFiles } from '../../tools/verify-core.mjs';
const root = resolve(process.argv[2]);
const evidence = resolve(fileURLToPath(new URL('.', import.meta.url)));
const baseline = JSON.parse(await readFile(join(evidence, 'overlay-after-focused-lifecycle-tests-inventory.json'), 'utf8'));
const digest = b => createHash('sha256').update(b).digest('hex');
const maintained = [];
for (const file of await maintainedFiles(root)) { const b = await readFile(file.fullPath); maintained.push({ path: file.relativePath, bytes: b.length, sha256: digest(b) }); }
maintained.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const serial = rows => rows.map(r => `${r.path}\0${r.bytes}\0${r.sha256}`).join('\n');
const nowDigest = digest(Buffer.from(serial(maintained)));
const baseMap = new Map(baseline.maintainedFiles.map(r => [r.path, r]));
const nowMap = new Map(maintained.map(r => [r.path, r]));
const changed = [];
for (const path of [...new Set([...baseMap.keys(), ...nowMap.keys()])].sort()) {
  const before = baseMap.get(path), after = nowMap.get(path);
  if (!before || !after || before.bytes !== after.bytes || before.sha256 !== after.sha256) changed.push({ path, before: before ?? null, after: after ?? null });
}
const outputFiles = [];
async function walk(path, rel) {
  let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  entries.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const abs = join(path, entry.name), relative = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(abs, relative);
    else if (entry.isFile()) { const b = await readFile(abs); outputFiles.push({ path: relative, bytes: b.length, sha256: digest(b) }); }
  }
}
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) if (entry.isDirectory()) await walk(join(root, 'packages', entry.name, 'dist'), `packages/${entry.name}/dist`);
for (const entry of await readdir(join(root, 'modules'), { withFileTypes: true })) if (entry.isDirectory()) await walk(join(root, 'modules', entry.name, 'dist'), `modules/${entry.name}/dist`);
await walk(join(root, '.artifacts'), '.artifacts');
for (const path of ['tsconfig.json','generated/catalog.mjs','generated/solution-catalog.mjs','OPEN_PLATFORM.html','visual/data.json']) {
  const abs = join(root, path); try { const s = await lstat(abs); if (s.isFile()) { const b = await readFile(abs); outputFiles.push({ path, bytes: b.length, sha256: digest(b) }); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
outputFiles.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const outputDigest = digest(Buffer.from(serial(outputFiles)));
const result = { schema: 'veyviz.original-root-build-deviation-capture.v1', capturedUtc: new Date().toISOString(), root, qualifyingSnapshotCandidate: baseline.candidateIdentity, qualifyingSnapshotDigest: baseline.maintainedDigest, activeRootMaintainedAfterBuild: { count: maintained.length, digest: nowDigest }, activeMaintainedDeltaFromCandidateSnapshot: { count: changed.length, paths: changed }, originalBuildOutputsAfterAttempt2: { count: outputFiles.length, digest: outputDigest, files: outputFiles }, attribution: 'No complete active-root pre-build inventory was captured; differences from the overlay candidate are not attributed solely to the original-root build. Generated output prior hashes are unknown.' };
const outPath = join(evidence, 'original-root-build-deviation-capture.json');
await writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ outputPath: outPath, activeMaintainedFileCount: maintained.length, activeMaintainedDigest: nowDigest, deltaCount: changed.length, deltaPaths: changed.map(r => r.path), generatedOutputCount: outputFiles.length, generatedOutputDigest: outputDigest, openPlatform: outputFiles.find(r => r.path === 'OPEN_PLATFORM.html') ?? null }) + '\n');
