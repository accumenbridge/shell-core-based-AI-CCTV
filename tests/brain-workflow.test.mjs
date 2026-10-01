import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../tools/brain.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);

async function putJson(root, path, value) {
    const full = join(root, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, `${JSON.stringify(value, null, 2)}\n`);
}

async function cli(root, args) {
    return spawnSync(process.execPath, [CLI, '--root', root, ...args, '--json'], {
        cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
}

async function cliText(root, args) {
    return spawnSync(process.execPath, [CLI, '--root', root, ...args], {
        cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
}

function output(result) {
    const source = result.stdout.trim() ? result.stdout : result.stderr;
    try { return JSON.parse(source); }
    catch (error) { assert.fail(`CLI did not return JSON. exit=${result.status}\n${source}\n${error.message}`); }
}

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'qb-brain-fixture-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const path of ['src', '.brain/tasks', '.brain/evidence', '.brain/inputs', '.brain/workflow/contracts', '.brain/workflow/runs', '.brain/workflow/events', '.brain/workflow/artifacts'])
        await mkdir(join(root, ...path.split('/')), { recursive: true });
    await writeFile(join(root, 'src/code.txt'), 'initial source\n');
    const legacyTask = '.brain/tasks/current-platform.md';
    await writeFile(join(root, legacyTask), `# Imported platform task\n${'historic context '.repeat(320)}\n`);
    await writeFile(join(root, '.brain/tasks/tools.md'), '# Tooling maintenance task\n');
    await writeFile(join(root, '.brain/PROGRESS.md'), '# Preserved legacy progress\n');
    await writeFile(join(root, '.brain/checks.json'), '{"schema":"legacy"}\n');
    const project = {
        schema: 'brain.project-setup.v1', name: 'Fixture', kind: 'test', repositories: [{ id: 'main', path: '.', purpose: 'isolated fixture' }],
        canonical: {
            brief: '.brain/BRIEF.md', outcome: '.brain/OUTCOME.md', acceptance: '.brain/ACCEPTANCE.md', strategy: '.brain/STRATEGY.md',
            decisions: '.brain/DECISIONS.md', progress: '.brain/PROGRESS.md', current_work: legacyTask
        },
        execution: { mode: 'existing_agent_sessions', automatic_dispatch: false, maximum_active_writers: 1 },
        commands_file: '.brain/checks.json', policy_file: '.brain/policy.json', setup_status: 'adopted', note: 'Fixture only.'
    };
    await putJson(root, '.brain/project.json', project);
    const recipes = {
        schema: 'brain.recipe-catalog.v1',
        recipes: [
            { id: 'required-check', argv: ['node', '--version'], cwd: '.', description: 'Required fixture check.', criterionIds: ['scope'], evidenceScope: 'Fixture CLI run.' },
            { id: 'suite-observation', argv: ['npm', 'test'], cwd: '.', description: 'Reported whole-suite observation.', criterionIds: ['scope'], evidenceScope: 'Outcome with named blockers.' }
        ]
    };
    await putJson(root, '.brain/workflow/recipes.json', recipes);
    const legacyContract = {
        schema: 'brain.task-contract.v1', taskId: 'LEGACY-001', title: 'Imported platform state',
        authorization: { kind: 'reported_import', reference: 'Preserved fixture history; no new authorization.' },
        sourceTaskRef: legacyTask,
        owners: { coordinator: 'root', implementer: 'legacy worker', reviewer: 'legacy reviewer' },
        allowedPaths: ['src/code.txt'], excludedActions: ['new acceptance'], prerequisites: [],
        criteria: [{ id: 'legacy-context', description: 'Keep imported status reported.', evidenceScope: 'Historical source only.' }],
        requiredRecipeIds: [], reviewRequirement: { required: false, independence: 'none' }
    };
    const taskContract = {
        schema: 'brain.task-contract.v1', taskId: 'TOOLS-001', title: 'Fixture tooling task',
        authorization: { kind: 'authorized', reference: 'Explicit fixture authorization.' },
        sourceTaskRef: '.brain/tasks/tools.md',
        owners: { coordinator: 'root', implementer: 'worker', reviewer: 'reviewer' },
        allowedPaths: ['src/code.txt'], excludedActions: ['external action'], prerequisites: [],
        criteria: [{ id: 'scope', description: 'Exercise required tool behavior.', evidenceScope: 'Isolated CLI behavior.' }],
        requiredRecipeIds: ['required-check'], requiredObservationRecipeIds: ['suite-observation'],
        reviewRequirement: { required: true, independence: 'independent_reported' }
    };
    await putJson(root, '.brain/workflow/contracts/LEGACY-001.json', legacyContract);
    await putJson(root, '.brain/workflow/contracts/TOOLS-001.json', taskContract);
    return { root, project, recipes, legacyTask, taskContract };
}

async function adoptFixtureMap(root, project) {
    project.canonical.progress = '.brain/CURRENT.md';
    project.commands_file = '.brain/workflow/recipes.json';
    await putJson(root, '.brain/project.json', project);
}

async function seedCheckpoint(root, maintenanceStatus = 'IMPLEMENTING') {
    const source = await readFile(join(root, '.brain/tasks/current-platform.md'));
    const input = {
        schema: 'brain.checkpoint-input.v1', reportedActor: 'fixture coordinator',
        platformTask: {
            taskId: 'LEGACY-001', status: 'REPORTED_IN_PROGRESS', candidate: null, runIds: [], reviewIds: [], blockers: [],
            nextAction: 'Preserve the mapped platform task and continue its separately authorized work.',
            gates: [{ id: 'browser', status: 'BLOCKED', evidenceRefs: ['.brain/evidence/browser.json'], limitations: ['Fixture report; no browser assertion.'] }],
            importProvenance: {
                sourceRef: '.brain/tasks/current-platform.md', sourceSha256: sha(source), originalStatus: 'IMPLEMENTING', observedAt: null,
                limitations: ['Imported status only; it does not establish current platform acceptance.']
            }
        },
        maintenanceTask: {
            taskId: 'TOOLS-001', status: maintenanceStatus, candidate: null, runIds: [], reviewIds: [], blockers: [],
            nextAction: 'Implement and qualify the local workflow tools.', gates: []
        }
    };
    await putJson(root, '.brain/inputs/seed.json', input);
    const result = await cli(root, ['checkpoint', '--input', '.brain/inputs/seed.json', '--expected-revision', '0']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return output(result);
}

async function recordInput(root, input, filename) {
    const path = `.brain/inputs/${filename}`;
    await putJson(root, path, { schema: 'brain.record-input.v1', ...input });
    const result = await cli(root, ['record', '--input', path]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return output(result);
}

function checkpointTask(status, candidate, runIds = [], reviewIds = []) {
    return {
        taskId: 'TOOLS-001', status, candidate, runIds, reviewIds, blockers: [],
        nextAction: status === 'ACCEPTED' ? 'Complete.' : 'Continue scoped implementation.',
        gates: [{ id: 'provider-live', status: 'NOT_RUN', evidenceRefs: [], limitations: ['No provider integration was in scope.'] }]
    };
}

async function publish(root, expectedRevision, maintenanceTask) {
    const inputPath = `.brain/inputs/publish-${expectedRevision}-${maintenanceTask.status}.json`;
    const input = {
        schema: 'brain.checkpoint-input.v1', reportedActor: 'fixture coordinator',
        platformTask: {
            taskId: 'LEGACY-001', status: 'REPORTED_IN_PROGRESS', candidate: null, runIds: [], reviewIds: [], blockers: [],
            nextAction: 'Continue mapped platform task.',
            gates: [{ id: 'browser', status: 'BLOCKED', evidenceRefs: ['.brain/evidence/browser.json'], limitations: ['No browser assertion.'] }],
            importProvenance: {
                sourceRef: '.brain/tasks/current-platform.md', sourceSha256: sha(await readFile(join(root, '.brain/tasks/current-platform.md'))), originalStatus: 'IMPLEMENTING', observedAt: null,
                limitations: ['Reported import only.']
            }
        },
        maintenanceTask
    };
    await putJson(root, inputPath, input);
    return cli(root, ['checkpoint', '--input', inputPath, '--expected-revision', String(expectedRevision)]);
}

async function publishPlatformOnly(root, expectedRevision, platformTask) {
    const inputPath = `.brain/inputs/platform-only-${expectedRevision}.json`;
    await putJson(root, inputPath, { schema: 'brain.checkpoint-input.v1', reportedActor: 'fixture coordinator', platformTask });
    return cli(root, ['checkpoint', '--input', inputPath, '--expected-revision', String(expectedRevision)]);
}

async function configureGroundedAtlas(root, project, taskContract) {
    project.canonical.current_work = taskContract.sourceTaskRef;
    await adoptFixtureMap(root, project);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/architecture.md'), 'Accepted core boundary.\n');
    await writeFile(join(root, 'docs/future.md'), 'Future design note.\n');
    const currentTask = await readFile(join(root, taskContract.sourceTaskRef));
    const profile = {
        schema: 'brain.atlas.v1', projectId: 'fixture-project', title: 'Fixture project', planRevision: 1,
        updatedAt: '2026-10-01T00:00:00.000Z', intentBasis: 'A bounded current outcome.',
        vision: { destination: 'Deliver the scoped core outcome.', users: ['Owner'], nonGoals: ['Unrelated breadth'], successSignals: [] },
        policy: { coreFirst: 'Finish the current behavior.', workInProgressLimit: 1, reviewCadence: [], nonNegotiables: [], deferRule: 'Defer unrelated ideas.' },
        sourceRefs: [
            { id: 'current-task', path: taskContract.sourceTaskRef, role: 'Canonical current task', sha256: sha(currentTask) },
            { id: 'architecture', path: 'docs/architecture.md', role: 'Governing architecture', sha256: sha('Accepted core boundary.\n') },
            { id: 'future-design', path: 'docs/future.md', role: 'Unselected future design', sha256: sha('Future design note.\n') }
        ],
        nodes: [
            { id: 'M-ARCH', kind: 'component', title: 'Accepted architecture boundary', summary: 'Preserve the source owner boundary.', owner: 'Fixture owner', intentStatus: 'accepted', priority: 'core', priorityReason: 'Required dependency.', dependsOn: [], links: [], sourceRefs: ['architecture'], acceptance: ['The implementation remains within this boundary.'] },
            { id: 'M-CORE', kind: 'milestone', title: 'Current core task', summary: 'Complete the mapped task.', owner: 'Fixture owner', intentStatus: 'accepted', priority: 'core', priorityReason: 'Current authorized work.', dependsOn: ['M-ARCH'], links: [], sourceRefs: ['current-task'], acceptance: ['The task contract outcome is demonstrated.'] },
            { id: 'B-FUTURE', kind: 'backlog', title: 'Future design', summary: 'A later idea.', owner: 'Fixture owner', intentStatus: 'proposed', priority: 'later', priorityReason: 'Not selected now.', dependsOn: [], links: [], sourceRefs: ['future-design'], acceptance: [] }
        ],
        observations: [], retrospectives: [], focusNodeId: 'M-CORE'
    };
    await putJson(root, '.brain/atlas/project.json', profile);
    return profile;
}

test('bootstrap checkpoint, sourceTaskRef mapping, focused context, and project adoption preserve imported scope', async t => {
    const { root, project } = await fixture(t);
    const seeded = await seedCheckpoint(root);
    assert.equal(seeded.pointer.revision, 1);
    await adoptFixtureMap(root, project);

    const pointerBefore = await readFile(join(root, '.brain/workflow/current.json'));
    const recordNamesBefore = await readdir(join(root, '.brain/workflow/runs'));
    const result = await cli(root, ['context', '--task', 'TOOLS-001']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = output(result);
    assert.equal(value.mappedCurrentTaskId, 'LEGACY-001'); // Identity is mapped by sourceTaskRef, not filename.
    assert.equal(value.sourceTask.path, '.brain/tasks/tools.md');
    assert.equal(value.sourceTask.truncated, false);
    assert.equal(value.checkpoint.currentTasks.platformTask.status, 'REPORTED_IN_PROGRESS');
    assert.equal(value.checkpoint.currentTasks.maintenanceTask.status, 'IMPLEMENTING');
    assert.equal(value.evidenceAssessment.status, 'NOT_QUALIFIED');
    assert.equal(value.executionReadiness.status, 'LEGACY_COMPATIBLE');
    assert.equal(value.executionReadiness.canonicalTask.taskId, 'LEGACY-001');
    assert.equal(value.executionReadiness.legacyCompatibility, true);
    assert.equal(value.checkpoint.taskState.nextAction, 'Implement and qualify the local workflow tools.');
    assert.doesNotMatch(value.sourceTask.excerpt, /historic context historic context/);
    assert.deepEqual(await readFile(join(root, '.brain/workflow/current.json')), pointerBefore);
    assert.deepEqual(await readdir(join(root, '.brain/workflow/runs')), recordNamesBefore);

    const check = await cli(root, ['validate']);
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.equal(output(check).status, 'VALID');
    assert.equal(output(check).integrity.status, 'VALID');
    const legacyPreflight = await cli(root, ['preflight']);
    assert.equal(legacyPreflight.status, 0, legacyPreflight.stderr || legacyPreflight.stdout);
    assert.equal(output(legacyPreflight).admission, 'READY');
    assert.equal(output(legacyPreflight).executionReadiness.status, 'LEGACY_COMPATIBLE');
});

test('preflight grounds new platform implementation in focus, prerequisite sources and the canonical task while leaving failures recordable', async t => {
    const { root, project, taskContract } = await fixture(t);
    const profile = await configureGroundedAtlas(root, project, taskContract);
    const ready = await cli(root, ['preflight']);
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    const readyResult = output(ready);
    assert.equal(readyResult.integrity.status, 'VALID');
    assert.equal(readyResult.executionReadiness.status, 'READY');
    assert.equal(readyResult.executionReadiness.focus.nodeId, 'M-CORE');
    const readable = await cliText(root, ['preflight']);
    assert.equal(readable.status, 0, readable.stderr || readable.stdout);
    assert.match(readable.stdout, /Execution readiness: READY/);
    assert.match(readable.stdout, /Canonical task: TOOLS-001/);
    assert.match(readable.stdout, /Planning focus: M-CORE/);

    const first = await publishPlatformOnly(root, 0, checkpointTask('READY', null));
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const pointerBeforeBlockedTransition = await readFile(join(root, '.brain/workflow/current.json'));
    const eventNamesBeforeBlockedTransition = await readdir(join(root, '.brain/workflow/events'));

    await writeFile(join(root, 'docs/future.md'), 'Changed unrelated future design.\n');
    const unrelatedDrift = output(await cli(root, ['preflight']));
    assert.equal(unrelatedDrift.executionReadiness.status, 'READY');
    assert.equal(unrelatedDrift.executionReadiness.governingSources.some(source => source.id === 'future-design'), false);

    await writeFile(join(root, 'docs/architecture.md'), 'Changed governing architecture.\n');
    const blocked = await cli(root, ['preflight']);
    assert.equal(blocked.status, 1);
    const blockedResult = output(blocked);
    assert.equal(blockedResult.integrity.status, 'VALID');
    assert.equal(blockedResult.executionReadiness.status, 'NOT_READY');
    assert.ok(blockedResult.executionReadiness.reasons.some(item => item.code === 'GOVERNING_SOURCE_NOT_CURRENT' && item.details.sourceId === 'architecture'));

    const implementing = await publishPlatformOnly(root, 1, checkpointTask('IMPLEMENTING', null));
    assert.equal(implementing.status, 1);
    assert.equal(output(implementing).error.code, 'EXECUTION_NOT_READY');
    assert.deepEqual(await readFile(join(root, '.brain/workflow/current.json')), pointerBeforeBlockedTransition);
    assert.deepEqual(await readdir(join(root, '.brain/workflow/events')), eventNamesBeforeBlockedTransition);

    const failureCanBeRecorded = await publishPlatformOnly(root, 1, checkpointTask('BLOCKED', null));
    assert.equal(failureCanBeRecorded.status, 0, failureCanBeRecorded.stderr || failureCanBeRecorded.stdout);
    const failedState = output(await cli(root, ['context']));
    assert.equal(failedState.checkpoint.currentTasks.platformTask.status, 'BLOCKED');
    assert.equal(failedState.executionReadiness.status, 'NOT_READY');

    profile.planRevision++;
    profile.updatedAt = '2026-10-01T01:00:00.000Z';
    profile.sourceRefs.find(source => source.id === 'architecture').sha256 = sha('Changed governing architecture.\n');
    await putJson(root, '.brain/atlas/project.json', profile);
    const reconciled = await cli(root, ['preflight']);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.equal(output(reconciled).executionReadiness.status, 'READY');
    const resumed = await publishPlatformOnly(root, 2, checkpointTask('IMPLEMENTING', null));
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
});

test('required records, copied evidence, independent review, and observation-only blocked suite gate control acceptance', async t => {
    const { root, project } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const contextResult = output(await cli(root, ['context', '--task', 'TOOLS-001']));
    const candidate = contextResult.candidate;

    await writeFile(join(root, '.brain/evidence/not-run-suite.tap'), 'No npm test invocation occurred.\n');
    const pass = await recordInput(root, {
        kind: 'run', taskId: 'TOOLS-001', recipeId: 'required-check', status: 'PASSED', exitCode: 0,
        environment: { node: process.version, platform: process.platform }, artifactPaths: [],
        provenance: { kind: 'reported', reference: 'Actual local fixture command log.' }, limitations: [], candidate
    }, 'pass.json');
    const notRun = await recordInput(root, {
        kind: 'run', taskId: 'TOOLS-001', recipeId: 'suite-observation', status: 'NOT_RUN', exitCode: null,
        environment: { node: process.version }, artifactPaths: ['.brain/evidence/not-run-suite.tap'],
        provenance: { kind: 'reported', reference: 'The optional observation was not run yet.' }, limitations: ['Not run.'], candidate
    }, 'not-run.json');
    const review = await recordInput(root, {
        kind: 'review', taskId: 'TOOLS-001', reviewer: 'reviewer', implementer: 'worker', independence: 'independent_reported',
        outcome: 'ACCEPTED', scope: 'Exact fixture workflow contract.', artifactPaths: [],
        provenance: { kind: 'reported', reference: 'Separate reviewer report.' }, limitations: ['Attribution is reported, not authenticated.'], candidate
    }, 'review.json');
    const ids = [pass.record.id, notRun.record.id];
    const reviewIds = [review.record.id];

    let publishResult = await publish(root, 1, checkpointTask('REVIEW', candidate, ids, reviewIds));
    assert.equal(publishResult.status, 0, publishResult.stderr || publishResult.stdout);
    publishResult = await publish(root, 2, checkpointTask('ACCEPTED', candidate, ids, reviewIds));
    assert.equal(publishResult.status, 1);
    assert.match(output(publishResult).error.code, /ACCEPTANCE_EVIDENCE_MISSING/);
    assert.match(output(publishResult).error.message, /required_observation_missing:suite-observation/);

    await writeFile(join(root, '.brain/evidence/full-suite.tap'), 'npm test exit 0; one unrelated profile case skipped\n');
    const observation = await recordInput(root, {
        kind: 'run', taskId: 'TOOLS-001', recipeId: 'suite-observation', status: 'BLOCKED', exitCode: 0,
        environment: { node: process.version }, counts: { tests: 3, passed: 2, failed: 0, cancelled: 0, skipped: 1, todo: 0 },
        artifactPaths: ['.brain/evidence/full-suite.tap'],
        provenance: { kind: 'reported', reference: 'Actual npm test output.' },
        limitations: ['One unrelated suite gate was skipped.'], candidate
    }, 'observation.json');
    ids.push(observation.record.id);
    publishResult = await publish(root, 2, checkpointTask('REVIEW', candidate, ids, reviewIds));
    assert.equal(publishResult.status, 0, publishResult.stderr || publishResult.stdout);
    publishResult = await publish(root, 3, checkpointTask('ACCEPTED', candidate, ids, reviewIds));
    assert.equal(publishResult.status, 0, publishResult.stderr || publishResult.stdout);
    assert.equal(output(publishResult).event.maintenanceTask.status, 'ACCEPTED');
    assert.equal(output(await cli(root, ['validate'])).status, 'VALID');

    const copied = join(root, ...observation.record.artifacts[0].path.split('/'));
    await writeFile(copied, 'tampered evidence\n');
    const invalid = output(await cli(root, ['validate']));
    assert.equal(invalid.status, 'INVALID');
    assert.equal(invalid.errors[0].code, 'ARTIFACT_INTEGRITY');
    const brokenContext = await cli(root, ['context', '--task', 'TOOLS-001']);
    assert.equal(brokenContext.status, 1);
    assert.equal(output(brokenContext).error.code, 'ARTIFACT_INTEGRITY');
});

test('stale candidate evidence and stale scoped source cannot qualify after a source edit', async t => {
    const { root, project } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const candidate = output(await cli(root, ['context', '--task', 'TOOLS-001'])).candidate;
    const pass = await recordInput(root, {
        kind: 'run', taskId: 'TOOLS-001', recipeId: 'required-check', status: 'PASSED', exitCode: 0,
        environment: {}, artifactPaths: [], provenance: { kind: 'reported', reference: 'Fixture pass.' }, limitations: [], candidate
    }, 'stale-pass.json');
    await publish(root, 1, checkpointTask('REVIEW', candidate, [pass.record.id], []));
    await writeFile(join(root, 'src/code.txt'), 'changed after the recorded run\n');

    const contextValue = output(await cli(root, ['context', '--task', 'TOOLS-001']));
    assert.notEqual(contextValue.candidate.digest, candidate.digest);
    assert.equal(contextValue.evidenceAssessment.status, 'NOT_QUALIFIED');
    assert.ok(contextValue.evidenceAssessment.reasons.includes('checkpoint_candidate_stale'));
    const rejected = await publish(root, 2, checkpointTask('ACCEPTED', candidate, [pass.record.id], []));
    assert.equal(rejected.status, 1);
    assert.equal(output(rejected).error.code, 'STALE_ACCEPTANCE');
});

test('recipe definition changes invalidate otherwise passing record qualification', async t => {
    const { root, project, recipes } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const candidate = output(await cli(root, ['context', '--task', 'TOOLS-001'])).candidate;
    const pass = await recordInput(root, {
        kind: 'run', taskId: 'TOOLS-001', recipeId: 'required-check', status: 'PASSED', exitCode: 0,
        environment: {}, artifactPaths: [], provenance: { kind: 'reported', reference: 'Fixture pass.' }, limitations: [], candidate
    }, 'recipe-pass.json');
    await publish(root, 1, checkpointTask('REVIEW', candidate, [pass.record.id], []));
    recipes.recipes[0].argv = ['node', '-e', 'process.exit(0)'];
    await putJson(root, '.brain/workflow/recipes.json', recipes);
    const rejected = await publish(root, 2, checkpointTask('ACCEPTED', candidate, [pass.record.id], []));
    assert.equal(rejected.status, 1);
    assert.equal(output(rejected).error.code, 'ACCEPTANCE_EVIDENCE_MISSING');
    assert.match(output(rejected).error.message, /required_recipe_not_qualified|required_observation_missing/);
});

test('expected revision and the non-expiring participating-writer lock reject conflicting publication', async t => {
    const { root, project } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const stale = await cli(root, ['checkpoint', '--input', '.brain/inputs/seed.json', '--expected-revision', '0']);
    assert.equal(stale.status, 1);
    assert.equal(output(stale).error.code, 'STALE_REVISION');

    await writeFile(join(root, '.brain/workflow/writer.lock'), '{"schema":"brain.writer-lock.v1","token":"held"}\n');
    const blocked = await cli(root, ['checkpoint', '--input', '.brain/inputs/seed.json', '--expected-revision', '1']);
    assert.equal(blocked.status, 1);
    assert.equal(output(blocked).error.code, 'WRITER_LOCK_HELD');
    await rm(join(root, '.brain/workflow/writer.lock'));
});

test('stale generated view is detected and repaired from the current pointer', async t => {
    const { root, project } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    await writeFile(join(root, '.brain/CURRENT.md'), 'manually edited stale view\n');
    const pointerBefore = JSON.parse(await readFile(join(root, '.brain/workflow/current.json'), 'utf8'));
    const stale = output(await cli(root, ['validate']));
    assert.equal(stale.status, 'INVALID');
    assert.equal(stale.errors[0].code, 'CURRENT_VIEW_STALE');
    const repaired = await cli(root, ['checkpoint', '--render']);
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    assert.deepEqual(JSON.parse(await readFile(join(root, '.brain/workflow/current.json'), 'utf8')), pointerBefore);
    assert.equal(output(repaired).pointer.revision, pointerBefore.revision);
    assert.equal(output(await cli(root, ['validate'])).status, 'VALID');
});

test('orphan event material is reported but does not block a later same-revision publication', async t => {
    const { root, project } = await fixture(t);
    const first = await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const orphan = structuredClone(first.event);
    orphan.id = randomUUID();
    orphan.revision = 2;
    orphan.previousEventId = first.event.id;
    delete orphan.integritySha256;
    orphan.integritySha256 = sha(canonical(orphan));
    await putJson(root, `.brain/workflow/events/${orphan.id}.json`, orphan);
    const checked = output(await cli(root, ['validate']));
    assert.equal(checked.status, 'VALID');
    assert.equal(checked.summary.uncommittedEventCount, 1);
    assert.ok(checked.warnings.some(warning => warning.includes('Uncommitted event')));

    const next = await publish(root, 1, {
        taskId: 'TOOLS-001', status: 'IMPLEMENTING', candidate: null, runIds: [], reviewIds: [], blockers: [],
        nextAction: 'Continue implementation.', gates: []
    });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    const after = output(await cli(root, ['validate']));
    assert.equal(after.status, 'VALID');
    assert.equal(after.summary.eventCount, 2);
    assert.equal(after.summary.uncommittedEventCount, 1);
});

test('self-review, wrong-task evidence references, and imported acceptance are rejected', async t => {
    const { root, project } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const unsafe = await cli(root, ['context', '--task', '../TOOLS-001']);
    assert.equal(unsafe.status, 1);
    assert.equal(output(unsafe).error.code, 'INVALID_TASK_ID');

    const selfReviewPath = '.brain/inputs/self-review.json';
    await putJson(root, selfReviewPath, {
        schema: 'brain.record-input.v1',
        kind: 'review', taskId: 'TOOLS-001', reviewer: 'worker', implementer: 'worker', independence: 'independent_reported',
        outcome: 'ACCEPTED', scope: 'Self review.', artifactPaths: [],
        provenance: { kind: 'reported', reference: 'Fixture input.' }, limitations: []
    });
    const selfReview = await cli(root, ['record', '--input', selfReviewPath]);
    assert.equal(selfReview.status, 1);
    assert.equal(output(selfReview).error.code, 'REVIEW_NOT_INDEPENDENT');

    const wrongTaskReview = await recordInput(root, {
        kind: 'review', taskId: 'LEGACY-001', reviewer: 'legacy worker', implementer: 'legacy worker', independence: 'self',
        outcome: 'ACCEPTED', scope: 'A different task contract.', artifactPaths: [],
        provenance: { kind: 'reported', reference: 'Fixture input.' }, limitations: []
    }, 'wrong-task-review.json');
    const candidate = output(await cli(root, ['context', '--task', 'TOOLS-001'])).candidate;
    const wrongReference = await publish(root, 1, checkpointTask('REVIEW', candidate, [], [wrongTaskReview.record.id]));
    assert.equal(wrongReference.status, 1);
    assert.equal(output(wrongReference).error.code, 'MISMATCHED_RECORD_REFERENCE');

    const importedFixture = await fixture(t);
    const publishImported = async (status, expectedRevision) => {
        const task = {
            taskId: 'LEGACY-001', status, candidate: null, runIds: [], reviewIds: [], blockers: [],
            nextAction: 'Continue reported fixture state.', gates: []
        };
        const inputPath = `.brain/inputs/imported-${expectedRevision}.json`;
        await putJson(importedFixture.root, inputPath, {
            schema: 'brain.checkpoint-input.v1', reportedActor: 'fixture coordinator', platformTask: task
        });
        return cli(importedFixture.root, ['checkpoint', '--input', inputPath, '--expected-revision', String(expectedRevision)]);
    };
    assert.equal((await publishImported('IMPLEMENTING', 0)).status, 0);
    await adoptFixtureMap(importedFixture.root, importedFixture.project);
    assert.equal((await publishImported('REVIEW', 1)).status, 0);
    const importedAcceptance = await publishImported('ACCEPTED', 2);
    assert.equal(importedAcceptance.status, 1);
    assert.equal(output(importedAcceptance).error.code, 'UNAUTHORIZED_ACCEPTANCE');
});

test('path traversal and junction source paths fail closed', async t => {
    const { root, project, taskContract } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);

    project.canonical.current_work = '.brain/tasks/../outside.md';
    await putJson(root, '.brain/project.json', project);
    const traversal = await cli(root, ['context']);
    assert.equal(traversal.status, 1);
    assert.equal(output(traversal).error.code, 'PATH_OUTSIDE_ROOT');

    project.canonical.current_work = '.brain/tasks/current-platform.md';
    await putJson(root, '.brain/project.json', project);
    const outside = await mkdtemp(join(tmpdir(), 'qb-brain-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'code.txt'), 'outside source\n');
    await symlink(outside, join(root, 'linked'), 'junction');
    taskContract.allowedPaths = ['linked/code.txt'];
    await putJson(root, '.brain/workflow/contracts/TOOLS-001.json', taskContract);
    const junction = await cli(root, ['context', '--task', 'TOOLS-001']);
    assert.equal(junction.status, 1);
    assert.equal(output(junction).error.code, 'SYMLINK_PATH');
});

test('a historical accepted task remains readable after source, contract, and recipe evolution', async t => {
    const { root, project, recipes, taskContract } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const candidate = output(await cli(root, ['context', '--task', 'TOOLS-001'])).candidate;

    const pass = await recordInput(root, {
        kind: 'run', taskId: 'TOOLS-001', recipeId: 'required-check', status: 'PASSED', exitCode: 0,
        environment: {}, artifactPaths: [], provenance: { kind: 'reported', reference: 'Fixture pass.' }, limitations: [], candidate
    }, 'historical-pass.json');
    await writeFile(join(root, '.brain/evidence/historical-suite.tap'), 'Observed suite outcome with a separately unqualified gate.\n');
    const observation = await recordInput(root, {
        kind: 'run', taskId: 'TOOLS-001', recipeId: 'suite-observation', status: 'BLOCKED', exitCode: 1,
        environment: {}, artifactPaths: ['.brain/evidence/historical-suite.tap'],
        provenance: { kind: 'reported', reference: 'Fixture full-suite observation.' }, limitations: ['A separate gate remains blocked.'], candidate
    }, 'historical-suite.json');
    const review = await recordInput(root, {
        kind: 'review', taskId: 'TOOLS-001', reviewer: 'reviewer', implementer: 'worker', independence: 'independent_reported',
        outcome: 'ACCEPTED', scope: 'The exact fixture candidate.', artifactPaths: [],
        provenance: { kind: 'reported', reference: 'Separate fixture review.' }, limitations: [], candidate
    }, 'historical-review.json');
    const runs = [pass.record.id, observation.record.id];
    const reviews = [review.record.id];
    const reviewCheckpoint = await publish(root, 1, checkpointTask('REVIEW', candidate, runs, reviews));
    assert.equal(reviewCheckpoint.status, 0, reviewCheckpoint.stderr || reviewCheckpoint.stdout);
    const acceptedCheckpoint = await publish(root, 2, checkpointTask('ACCEPTED', candidate, runs, reviews));
    assert.equal(acceptedCheckpoint.status, 0, acceptedCheckpoint.stderr || acceptedCheckpoint.stdout);
    const acceptedEvent = output(acceptedCheckpoint).event;
    assert.equal(acceptedEvent.maintenanceTask.status, 'ACCEPTED');

    const dropped = await publishPlatformOnly(root, 3, acceptedEvent.platformTask);
    assert.equal(dropped.status, 0, dropped.stderr || dropped.stdout);
    assert.equal(output(dropped).event.maintenanceTask, undefined);

    await writeFile(join(root, 'src/code.txt'), 'evolved source after historical acceptance\n');
    taskContract.title = 'Evolved fixture tooling task';
    await putJson(root, '.brain/workflow/contracts/TOOLS-001.json', taskContract);
    recipes.recipes[0].argv = ['node', '--version', '--preserve-scope'];
    await putJson(root, '.brain/workflow/recipes.json', recipes);

    const current = output(await cli(root, ['validate']));
    assert.equal(current.status, 'VALID', JSON.stringify(current.errors));
    assert.equal(current.summary.revision, 4);
    assert.equal(current.summary.eventCount, 4);
});

test('READY future files remain a plan; bound missing files cannot qualify', async t => {
    const { root, project, taskContract } = await fixture(t);
    taskContract.allowedPaths.push('future/new-file.txt');
    await putJson(root, '.brain/workflow/contracts/TOOLS-001.json', taskContract);
    await seedCheckpoint(root, 'READY');
    await adoptFixtureMap(root, project);
    const planned = output(await cli(root, ['context', '--task', 'TOOLS-001']));
    assert.equal(planned.candidate, null);
    assert.deepEqual(planned.missingPlannedPaths, ['future/new-file.txt']);
    assert.equal(planned.evidenceAssessment.status, 'NOT_QUALIFIED');
    assert.equal(output(await cli(root, ['validate'])).status, 'VALID');
    await mkdir(join(root, 'future'));
    await writeFile(join(root, 'future/new-file.txt'), 'actual implementation\n');
    const candidate = output(await cli(root, ['context', '--task', 'TOOLS-001'])).candidate;
    assert.equal((await publish(root, 1, checkpointTask('IMPLEMENTING', candidate))).status, 0);
    await rm(join(root, 'future/new-file.txt'));
    assert.equal(output(await cli(root, ['validate'])).status, 'INVALID');
    assert.equal((await cli(root, ['context', '--task', 'TOOLS-001'])).status, 1);
});

test('planned files do not bypass parent type or path confinement', async t => {
    const { root, project, taskContract } = await fixture(t);
    await seedCheckpoint(root, 'READY');
    await adoptFixtureMap(root, project);
    taskContract.allowedPaths.push('src/code.txt/future.txt');
    await putJson(root, '.brain/workflow/contracts/TOOLS-001.json', taskContract);
    assert.equal(output(await cli(root, ['validate'])).errors[0].code, 'INVALID_PATH_KIND');
    taskContract.allowedPaths[1] = '../outside/new.txt';
    await putJson(root, '.brain/workflow/contracts/TOOLS-001.json', taskContract);
    assert.equal(output(await cli(root, ['validate'])).errors[0].code, 'PATH_OUTSIDE_ROOT');
});

test('unselected failures veto positives until same-scope evidenced resolution', async t => {
    const { root, project } = await fixture(t);
    await seedCheckpoint(root);
    await adoptFixtureMap(root, project);
    const candidate = output(await cli(root, ['context', '--task', 'TOOLS-001'])).candidate;
    await writeFile(join(root, '.brain/evidence/resolution.txt'), 'Fixture execution and finding disposition evidence.\n');
    const common = { taskId: 'TOOLS-001', candidate, artifactPaths: ['.brain/evidence/resolution.txt'],
        provenance: { kind: 'reported', reference: 'Isolated regression fixture' }, limitations: ['Fixture only.'] };
    const run = { ...common, kind: 'run', recipeId: 'required-check', status: 'PASSED', exitCode: 0, environment: { fixture: 'yes' } };
    const review = { ...common, kind: 'review', reviewer: 'reviewer', implementer: 'worker', independence: 'independent_reported',
        outcome: 'ACCEPTED', scope: 'Exact fixture behavior.' };
    const pass = await recordInput(root, run, 'pass.json');
    const reject = await recordInput(root, { ...review, outcome: 'CHANGES_REQUESTED' }, 'reject.json');
    const accept = await recordInput(root, review, 'accept.json');
    const fail = await recordInput(root, { ...run, status: 'FAILED', exitCode: 1 }, 'fail.json');
    const unknown = await recordInput(root, { ...run, status: 'UNKNOWN', exitCode: null }, 'unknown.json');
    // Observation-only failed suite evidence is retained without masquerading as a pass.
    const observed = await recordInput(root, { ...run, recipeId: 'suite-observation', status: 'FAILED', exitCode: 1 }, 'observed.json');
    const runIds = [pass.record.id, observed.record.id];
    assert.equal((await publish(root, 1, checkpointTask('REVIEW', candidate, runIds, [accept.record.id]))).status, 0);
    const assessed = output(await cli(root, ['context', '--task', 'TOOLS-001']));
    assert(assessed.evidenceAssessment.reasons.some(reason => reason.startsWith('unresolved_required_run:')));
    assert(assessed.evidenceAssessment.reasons.some(reason => reason.endsWith(unknown.record.id)));
    assert(assessed.evidenceAssessment.reasons.some(reason => reason.startsWith('unresolved_review:')));
    const refused = await publish(root, 2, checkpointTask('ACCEPTED', candidate, runIds, [accept.record.id]));
    assert.equal(output(refused).error.code, 'ACCEPTANCE_EVIDENCE_MISSING');
    const both = await publish(root, 2, checkpointTask('ACCEPTED', candidate, [...runIds, fail.record.id], [accept.record.id, reject.record.id]));
    assert.equal(output(both).error.code, 'ACCEPTANCE_EVIDENCE_MISSING');
    await putJson(root, '.brain/inputs/bad-resolution.json', { schema: 'brain.record-input.v1', ...review,
        resolution: { recordIds: [fail.record.id], reason: 'Attempted cross-kind resolution.' } });
    const invalid = await cli(root, ['record', '--input', '.brain/inputs/bad-resolution.json']);
    assert.equal(output(invalid).error.code, 'INVALID_RESOLUTION');
    const resolvedRun = await recordInput(root, { ...run,
        resolution: { recordIds: [fail.record.id, unknown.record.id], reason: 'Recorded diagnosis and actual rerun for the same check.' } }, 'resolved-run.json');
    const resolvedReview = await recordInput(root, { ...review,
        resolution: { recordIds: [reject.record.id], reason: 'The same reviewer explicitly resolves the named finding with evidence.' } }, 'resolved-review.json');
    const accepted = await publish(root, 2, checkpointTask('ACCEPTED', candidate, [resolvedRun.record.id, observed.record.id], [resolvedReview.record.id]));
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(output(await cli(root, ['validate'])).status, 'VALID');
    assert.equal(JSON.parse(await readFile(join(root, `.brain/workflow/runs/${fail.record.id}.json`), 'utf8')).status, 'FAILED');
});
