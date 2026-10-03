import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(process.argv[2]);
const evidence = resolve(fileURLToPath(new URL('.', import.meta.url)));
const j = async name => JSON.parse(await readFile(join(evidence, name), 'utf8'));
const t = async name => readFile(join(evidence, name), 'utf8');
const before = await j('pre-edit-active-owner-capture.json');
const after = await j('post-focused-tests-owner-capture.json');
const preBuild = await j('overlay-before-fresh-build-inventory.json');
const postTest = await j('overlay-after-focused-lifecycle-tests-inventory.json');
const overlay = await j('snapshot-overlay-adf30c71e8d92a86/overlay-manifest.json');
const rootDeviation = await j('original-root-build-deviation-capture.json');
const workOrder = JSON.parse(await readFile(join(root, '.brain/plans/veyviz-startup-close-work-order.json'), 'utf8'));
const parseExecution = async (name, command, logName, counts = null, qualifies = true) => {
  const raw = await t(logName);
  const exit = [...raw.matchAll(/EXIT_CODE=(\d+)/g)].at(-1)?.[1];
  const cwd = raw.match(/(?:^|\r?\n)CWD=([^\r\n]+)/)?.[1] ?? null;
  return { name, argv: command, cwd, exitCode: exit === undefined ? null : Number(exit), qualifying: qualifies, testCounts: counts, rawLog: join(evidence, logName) };
};
const executions = [
  await parseExecution('candidate-395412a9 fresh isolated build', ['npm','run','build'], 'build-attempt-1.txt'),
  await parseExecution('candidate-395412a9 focused lifecycle attempt 1', ['node','--test','tests/veyviz-lifecycle.test.mjs'], 'lifecycle-attempt-1.txt', { tests: 8, pass: 5, fail: 3, skipped: 0 }),
  await parseExecution('candidate-adf30c71 original-root misplaced build deviation', ['npm','run','build'], 'build-attempt-2.txt', null, false),
  await parseExecution('candidate-adf30c71 focused lifecycle attempt 2 before overlay build', ['node','--test','tests/veyviz-lifecycle.test.mjs'], 'lifecycle-attempt-2.txt', { tests: 8, pass: 1, fail: 7, skipped: 0 }, false),
  await parseExecution('candidate-adf30c71 fresh isolated build', ['npm','run','build'], 'build-attempt-3.txt'),
  await parseExecution('candidate-adf30c71 focused lifecycle attempt 3', ['node','--test','tests/veyviz-lifecycle.test.mjs'], 'lifecycle-attempt-3.txt', { tests: 8, pass: 8, fail: 0, skipped: 0 })
];
const sourcesBefore = new Map(before.files.map(x => [x.path, x]));
const sourcesAfter = new Map(after.files.map(x => [x.path, x]));
const exactOwnerPaths = ['tools/veyviz-start.mjs','tests/veyviz-lifecycle.test.mjs','tools/veyviz-runtime.mjs'].map(path => ({ path, before: sourcesBefore.get(path), after: sourcesAfter.get(path), changed: sourcesBefore.get(path)?.sha256 !== sourcesAfter.get(path)?.sha256 }));
const result = {
  schema: 'veyviz.startup-close-execution-index.v1',
  status: 'FROZEN_FOR_INDEPENDENT_REVIEW_NOT_ACCEPTED',
  capturedUtc: new Date().toISOString(),
  productRoot: root,
  workOrder: join(root, '.brain/plans/veyviz-startup-close-work-order.json'),
  admittedOwners: ['tools/veyviz-start.mjs','tests/veyviz-lifecycle.test.mjs'],
  ownerBytes: exactOwnerPaths,
  readonlyDependency: exactOwnerPaths.find(x => x.path === 'tools/veyviz-runtime.mjs'),
  candidate: {
    identity: overlay.candidateIdentity,
    baseIdentity: overlay.baseCandidateIdentity,
    snapshotRoot: overlay.snapshotRoot,
    manifest: join(evidence, 'snapshot-overlay-adf30c71e8d92a86/overlay-manifest.json'),
    maintainedFileCountBeforeBuild: preBuild.maintainedFileCount,
    maintainedDigestBeforeBuild: preBuild.maintainedDigest,
    maintainedFileCountAfterTests: postTest.maintainedFileCount,
    maintainedDigestAfterTests: postTest.maintainedDigest,
    sourceUnchangedAcrossBuildAndFocusedTests: preBuild.maintainedFileCount === postTest.maintainedFileCount && preBuild.maintainedDigest === postTest.maintainedDigest,
    publicLocalDeveloperProfile: overlay.publicProfile,
    generatedCatalogInputsAfterQualifyingBuild: [
      { path: '.artifacts/veyviz-catalog/plan.json', sha256: '0028623126e3fcccc81e55c591eef42d8a7f152446085589e5851688e98fa254', bytes: 10545 },
      { path: '.artifacts/veyviz-catalog/release.json', sha256: 'c85b953179d39e1223e0aa16da087e807cc374ae96e502c95e654522e9621c91', bytes: 4849 }
    ]
  },
  executions,
  failedOrNonqualifyingNotes: [
    { attempt: 'lifecycle-attempt-1', cause: 'New synthetic subcases reached UNKNOWN/token assertions, but their fake child never completed enrollment/access DB creation, so restart refused incomplete enrollment before testing UNKNOWN-owner refusal. Occupied-port and existing catalog lifecycle subtests passed.' },
    { attempt: 'build-attempt-2', cause: 'PowerShell command ran with active product root as CWD, not in the candidate overlay. Its exit 0 is a scope deviation and is not a qualifying snapshot build.' },
    { attempt: 'lifecycle-attempt-2', cause: 'Ran in unbuilt overlay; missing ignored build outputs .artifacts/veyviz-catalog/plan.json and release.json caused ENOENT. Preserved as setup failure.' }
  ],
  originalRootBuildDeviation: {
    command: ['npm','run','build'],
    cwd: rootDeviation.root,
    exitCode: executions.find(x => x.name.includes('original-root'))?.exitCode ?? null,
    capture: join(evidence, 'original-root-build-deviation-capture.json'),
    activeMaintainedAfterBuild: rootDeviation.activeRootMaintainedAfterBuild,
    deltaFromCandidateSnapshot: rootDeviation.activeMaintainedDeltaFromCandidateSnapshot,
    postStateGeneratedOutputCount: rootDeviation.originalBuildOutputsAfterAttempt2.count,
    postStateGeneratedOutputDigest: rootDeviation.originalBuildOutputsAfterAttempt2.digest,
    openPlatformPostState: rootDeviation.originalBuildOutputsAfterAttempt2.files.find(x => x.path === 'OPEN_PLATFORM.html'),
    priorGeneratedOutputHashes: 'unknown; no complete active-root pre-build capture was made',
    originalLive4494Impact: 'unknown; no claim made',
    runningProcessActions: 'none'
  },
  historicalDiagnosticClosure: workOrder.evidence?.historicalOriginalClosure ?? 'UNKNOWN: no later original-child close or cleanup proof exists in this index. New tests or different children cannot resolve it.',
  evidence: {
    preEditOwnerCapture: join(evidence,'pre-edit-active-owner-capture.json'),
    postTestOwnerCapture: join(evidence,'post-focused-tests-owner-capture.json'),
    beforeBuildInventory: join(evidence,'overlay-before-fresh-build-inventory.json'),
    afterTestInventory: join(evidence,'overlay-after-focused-lifecycle-tests-inventory.json'),
    deviationLog: join(evidence,'build-attempt-2.txt'),
    diagnosticUnknownReference: join(root,'.local/product-paging-evidence/independent-repair-review.md')
  },
  limitations: [
    'The qualifying build and lifecycle tests are isolated snapshot evidence; this is not a browser, production, full-suite, model, native, or live acceptance result.',
    'The original database-failure diagnostic child final close remains UNKNOWN; new deterministic children do not resolve it.',
    'No full npm test, real model, native integration, or browser/Playwright run was performed in this bounded task.',
    'Temporary test data roots .local/vp-sc1 and .local/vp-sc2 were left in place for root review; no cleanup was run.'
  ]
};
const out = join(evidence, 'execution-index-final.json');
await writeFile(out, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ output: out, candidate: result.candidate.identity, executions: executions.map(x => ({ name:x.name, cwd:x.cwd, exitCode:x.exitCode, testCounts:x.testCounts })), unchanged: result.candidate.sourceUnchangedAcrossBuildAndFocusedTests, ownerBytes: exactOwnerPaths }) + '\n');
