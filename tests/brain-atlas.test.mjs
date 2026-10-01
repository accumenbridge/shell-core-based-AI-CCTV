import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectAtlas, renderAtlas, validateAtlas } from '../tools/brain-atlas.mjs';

const TOOL = fileURLToPath(new URL('../tools/brain-atlas.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'qb-brain-atlas-'));
  t.after(async () => {
    const absolute = resolve(root);
    const temp = resolve(tmpdir());
    const fromTemp = relative(temp, absolute);
    if (!fromTemp || fromTemp === '..' || fromTemp.startsWith(`..${sep}`) || isAbsolute(fromTemp) || !basename(absolute).startsWith('qb-brain-atlas-')) {
      throw new Error(`Refusing to recursively remove a path outside this test's temporary root: ${absolute}`);
    }
    await rm(absolute, { recursive: true, force: true });
  });
  return root;
}

function cli(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024
  });
}

function init(root, projectId, title) {
  return cli(['init', '--root', root, '--project-id', projectId, '--title', title]);
}

function emptyProfile(projectId = 'atlas-fixture', title = 'Atlas fixture') {
  return {
    schema: 'brain.atlas.v1', projectId, title, planRevision: 1,
    updatedAt: '2026-10-01T00:00:00.000Z', intentBasis: 'Temporary test fixture.',
    vision: { destination: 'Fixture destination.', users: [], nonGoals: [], successSignals: [] },
    policy: { coreFirst: 'Core user outcome.', workInProgressLimit: 1, reviewCadence: [], nonNegotiables: [], deferRule: 'Defer unrelated work.' },
    sourceRefs: [], nodes: [], observations: [], retrospectives: []
  };
}

function sampleNode(id, kind = 'story') {
  return {
    id, kind, title: `${id} title`, summary: `${id} summary`, owner: 'fixture owner',
    intentStatus: 'accepted', priority: 'core', priorityReason: 'Required for the fixture outcome.',
    dependsOn: [], links: [], sourceRefs: [], acceptance: []
  };
}

function validateWithoutThrow(profile) {
  let result;
  assert.doesNotThrow(() => { result = validateAtlas(profile); });
  return result;
}

async function saveProfile(root, profile) {
  const atlasDir = join(root, '.brain', 'atlas');
  await mkdir(atlasDir, { recursive: true });
  await writeFile(join(atlasDir, 'project.json'), `${JSON.stringify(profile, null, 2)}\n`);
}

test('explicit-root init and render keep two temporary project atlases independent', async (t) => {
  const alphaRoot = await tempRoot(t);
  const betaRoot = await tempRoot(t);

  const alphaInit = init(alphaRoot, 'alpha-project', 'Alpha Project');
  assert.equal(alphaInit.status, 0, alphaInit.stderr || alphaInit.stdout);
  const alphaProfilePath = join(alphaRoot, '.brain', 'atlas', 'project.json');
  const alphaBeforeRepeat = await readFile(alphaProfilePath);
  const repeatedInit = init(alphaRoot, 'alpha-project', 'Changed Alpha');
  assert.notEqual(repeatedInit.status, 0);
  assert.deepEqual(await readFile(alphaProfilePath), alphaBeforeRepeat);

  const betaInit = init(betaRoot, 'beta-project', 'Beta Project');
  assert.equal(betaInit.status, 0, betaInit.stderr || betaInit.stdout);
  const alphaProfile = JSON.parse(await readFile(alphaProfilePath, 'utf8'));
  const betaProfile = JSON.parse(await readFile(join(betaRoot, '.brain', 'atlas', 'project.json'), 'utf8'));
  assert.equal(alphaProfile.projectId, 'alpha-project');
  assert.equal(betaProfile.projectId, 'beta-project');

  for (const root of [alphaRoot, betaRoot]) {
    const validation = cli(['validate', '--root', root]);
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
    const rendered = cli(['render', '--root', root]);
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  }
  const alphaHtml = await readFile(join(alphaRoot, '.brain', 'atlas', 'PROJECT_ATLAS.html'), 'utf8');
  const betaHtml = await readFile(join(betaRoot, '.brain', 'atlas', 'PROJECT_ATLAS.html'), 'utf8');
  assert.match(alphaHtml, /Alpha Project/);
  assert.doesNotMatch(alphaHtml, /Beta Project|beta-project/);
  assert.match(betaHtml, /Beta Project/);
  assert.doesNotMatch(betaHtml, /Alpha Project|alpha-project/);
});

test('structural validation reports broken links, cycles, and malformed dependencies without throwing', () => {
  const unknownLink = emptyProfile();
  unknownLink.nodes = [sampleNode('story-a')];
  unknownLink.nodes[0].links = ['story-missing'];
  const linkResult = validateWithoutThrow(unknownLink);
  assert.equal(linkResult.valid, false);
  assert.ok(linkResult.errors.some((error) => error.includes('links references unknown node story-missing')));

  const cycle = emptyProfile();
  const first = sampleNode('milestone-a', 'milestone');
  const second = sampleNode('milestone-b', 'milestone');
  first.dependsOn = ['milestone-b'];
  second.dependsOn = ['milestone-a'];
  cycle.nodes = [first, second];
  const cycleResult = validateWithoutThrow(cycle);
  assert.equal(cycleResult.valid, false);
  assert.ok(cycleResult.errors.some((error) => error.includes('dependency cycle')));

  const malformed = emptyProfile();
  const malformedNode = sampleNode('story-malformed');
  malformedNode.dependsOn = { node: 'story-other' };
  malformed.nodes = [malformedNode];
  const malformedResult = validateWithoutThrow(malformed);
  assert.equal(malformedResult.valid, false);
  assert.ok(malformedResult.errors.some((error) => error.includes('dependsOn must be an array')));
});

test('source inspection distinguishes matched pins, drift, and missing pinned files', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const sourceBytes = 'current fixture source\n';
  await writeFile(join(root, 'src', 'contract.md'), sourceBytes);
  const profile = emptyProfile();
  profile.sourceRefs = [
    { id: 'contract-source', path: 'src/contract.md', role: 'Fixture contract', sha256: sha(sourceBytes) },
    { id: 'missing-source', path: 'src/not-created.md', role: 'Missing fixture reference', sha256: sha('pinned missing bytes') }
  ];
  await saveProfile(root, profile);

  const initial = await inspectAtlas(root);
  assert.equal(initial.valid, true);
  assert.equal(initial.status, 'DEGRADED');
  assert.deepEqual(initial.sourceChecks.map((item) => item.state), ['MATCHED', 'MISSING']);

  await writeFile(join(root, 'src', 'contract.md'), 'evolved fixture source\n');
  const drifted = await inspectAtlas(root);
  assert.equal(drifted.valid, true);
  assert.deepEqual(drifted.sourceChecks.map((item) => item.state), ['DRIFT', 'MISSING']);
  assert.notEqual(drifted.sourceChecks[0].currentSha256, drifted.sourceChecks[0].expectedSha256);
});

test('offline rendering escapes hostile text and gives each observation one canonical anchor', () => {
  const profile = emptyProfile('safe-project', '<svg onload="alert(1)">Project</svg>');
  profile.vision.destination = '<script>alert("vision")</script>';
  profile.sourceRefs = [{ id: 'source-a', path: 'src/spec.md', role: '<img src=x onerror=alert(1)>', sha256: sha('spec') }];
  const screen = sampleNode('screen-a', 'screen');
  screen.title = '</h3><script>alert("node")</script>';
  screen.summary = '<svg onload=alert(1)>';
  screen.sourceRefs = ['source-a'];
  profile.nodes = [screen];
  profile.observations = [
    { id: 'observation-a', nodeId: 'screen-a', state: 'reported', summary: '<script>alert("observation")</script>', sourceRefs: ['source-a'], candidate: null, observedAt: '2026-10-01T01:00:00Z', provenance: 'reported-history', limitations: [] },
    { id: 'observation-b', nodeId: 'screen-a', state: 'blocked', summary: 'Blocked fixture observation.', sourceRefs: [], candidate: null, observedAt: '2026-10-01T02:00:00Z', provenance: 'source-inspection', limitations: [] }
  ];
  profile.retrospectives = [{
    id: 'retro-a', problem: '<script>alert("retro")</script>', evidenceRefs: ['observation-a', 'source-a'],
    hypothesis: 'A fixture hypothesis.', action: 'Review the fixture.', owner: 'fixture owner', measure: '', status: 'proposed'
  }];
  assert.equal(validateAtlas(profile).valid, true);

  const html = renderAtlas(profile);
  assert.doesNotMatch(html, /<script(?:\s|>)/i);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;svg onload=/);
  for (const id of ['observation-a', 'observation-b']) {
    const anchors = html.match(new RegExp(`id="observation-${id}"`, 'g')) ?? [];
    assert.equal(anchors.length, 1, `${id} should have one page anchor`);
  }
  assert.match(html, /href="#observation-observation-a"/);
  assert.match(html, /No future measure recorded; improvement remains unmeasured\./);
});

test('render refuses to replace an arbitrary existing user file', async (t) => {
  const root = await tempRoot(t);
  const created = init(root, 'protected-project', 'Protected Project');
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const target = join(root, '.brain', 'atlas', 'PROJECT_ATLAS.html');
  const userBytes = '<!doctype html><title>User-owned page</title>\n';
  await writeFile(target, userBytes);

  const rendered = cli(['render', '--root', root]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /not a generated Brain atlas|refusing to overwrite/i);
  assert.equal(await readFile(target, 'utf8'), userBytes);
});

test('source paths escaping the selected project root are structurally invalid', async (t) => {
  const root = await tempRoot(t);
  const profile = emptyProfile();
  profile.sourceRefs = [{ id: 'outside-source', path: '../outside.md', role: 'Must remain confined' }];
  await saveProfile(root, profile);

  const inspection = await inspectAtlas(root);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.status, 'INVALID');
  assert.ok(inspection.errors.some((error) => error.includes('confined repository-relative path')));
  assert.deepEqual(inspection.sourceChecks, []);
});

test('source inspection marks junction traversal unsafe', async (t) => {
  const root = await tempRoot(t);
  const outside = await tempRoot(t);
  await writeFile(join(outside, 'evidence.md'), 'outside evidence\n');
  try {
    await symlink(outside, join(root, 'linked-source'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(error.code)) {
      t.skip(`Could not create the test junction in this environment (${error.code}).`);
      return;
    }
    throw error;
  }
  const profile = emptyProfile();
  profile.sourceRefs = [{ id: 'junction-source', path: 'linked-source/evidence.md', role: 'Must stay within root' }];
  await saveProfile(root, profile);

  const inspection = await inspectAtlas(root);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.sourceChecks[0].state, 'UNSAFE');
  assert.ok(inspection.errors.some((error) => error.includes('symlink or junction')));
});

test('source and observation identifiers cannot collide across reference namespaces', () => {
  const profile = emptyProfile();
  profile.sourceRefs = [{ id: 'same-id', path: 'spec.md', role: 'Fixture source' }];
  profile.nodes = [sampleNode('node-a')];
  profile.observations = [{
    id: 'same-id', nodeId: 'node-a', state: 'reported', summary: 'Ambiguous evidence reference.',
    sourceRefs: ['same-id'], candidate: null, observedAt: '2026-10-01T01:00:00Z',
    provenance: 'reported-history', limitations: []
  }];

  const validation = validateWithoutThrow(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('collides with source reference same-id')));
});

test('inspection binds the full profile and checked source set; renderer derives status from checks', async (t) => {
  const root = await tempRoot(t);
  const current = 'current inspection bytes\n';
  await writeFile(join(root, 'source.md'), current);
  const profile = emptyProfile('bound-project', 'Bound Project');
  profile.sourceRefs = [{ id: 'pinned-source', path: 'source.md', role: 'Digest fixture', sha256: sha('earlier bytes\n') }];
  await saveProfile(root, profile);

  const inspection = await inspectAtlas(root);
  assert.equal(inspection.projectId, profile.projectId);
  assert.match(inspection.profileDigest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(inspection.inspectedAt)));
  assert.equal(inspection.status, 'DEGRADED');
  const forgedStatus = structuredClone(inspection);
  forgedStatus.status = 'VALID';
  const html = renderAtlas(profile, forgedStatus);
  assert.match(html, /Source inspection: DEGRADED/);
  assert.match(html, new RegExp(inspection.profileDigest));
  assert.match(html, new RegExp(inspection.inspectedAt));

  const changedProfile = structuredClone(profile);
  changedProfile.title = 'Changed Project';
  assert.throws(() => renderAtlas(changedProfile, inspection), /profile digest/i);
  const changedInspectionTime = structuredClone(inspection);
  changedInspectionTime.inspectedAt = '2026-10-02T00:00:00.000Z';
  assert.throws(() => renderAtlas(profile, changedInspectionTime), /inspection digest/i);
  const otherProject = structuredClone(profile);
  otherProject.projectId = 'other-project';
  assert.throws(() => renderAtlas(otherProject, inspection), /different project identity|profile digest/i);

  const badBindings = [
    (copy) => { copy.sourceChecks = []; },
    (copy) => { copy.sourceChecks.push({ ...copy.sourceChecks[0], id: 'extra-source' }); },
    (copy) => { copy.sourceChecks.push({ ...copy.sourceChecks[0] }); },
    (copy) => { copy.sourceChecks[0].path = 'other.md'; },
    (copy) => { copy.sourceChecks[0].expectedSha256 = sha('wrong pin'); },
    (copy) => { copy.sourceChecks[0].state = 'UNKNOWN_STATE'; },
    (copy) => { copy.sourceChecks[0].state = 'MATCHED'; },
  ];
  for (const mutate of badBindings) {
    const bad = structuredClone(inspection);
    mutate(bad);
    assert.throws(() => renderAtlas(profile, bad), /source check|inspection path|expected digest|matched state/i);
  }

  const uninspected = renderAtlas(profile);
  assert.match(uninspected, /Source inspection: NOT_INSPECTED/);
  assert.match(uninspected, /Source files have not been inspected; no source validity is inferred/);
});

test('planning focus and bounded gaps stay distinct from structure and current-work selection', async (t) => {
  const root = await tempRoot(t);
  const sourceBytes = 'focus source current\n';
  await writeFile(join(root, 'focus.md'), sourceBytes);
  const profile = emptyProfile('focus-project', 'Focus Project');
  profile.intentBasis = '';
  profile.vision.destination = '';
  profile.vision.users = [];
  profile.sourceRefs = [{ id: 'focus-source', path: 'focus.md', role: 'Focus evidence', sha256: sha('stale pin\n') }];
  const journey = sampleNode('J-FOCUS', 'journey');
  const screen = sampleNode('S-PROPOSED', 'screen');
  screen.intentStatus = 'proposed';
  const milestone = sampleNode('M-FOCUS', 'milestone');
  const story = sampleNode('ST-DEPENDENT', 'story');
  story.dependsOn = ['M-FOCUS'];
  profile.nodes = [journey, screen, milestone, story];
  milestone.sourceRefs = ['focus-source'];
  profile.focusNodeId = 'M-FOCUS';
  profile.observations = [{
    id: 'OBS-FOCUS', nodeId: 'M-FOCUS', state: 'unknown', summary: 'Focus evidence is unknown.',
    sourceRefs: ['focus-source'], candidate: null, observedAt: '2026-10-01T02:00:00Z',
    provenance: 'source-inspection', limitations: ['No execution record.']
  }];
  assert.equal(validateAtlas(profile).valid, true);
  assert.equal(validateAtlas({ ...profile, focusNodeId: 'M-MISSING' }).valid, false);

  await saveProfile(root, profile);
  const inspection = await inspectAtlas(root);
  assert.equal(inspection.structuralStatus, 'VALID');
  assert.equal(inspection.sourceStatus, 'DEGRADED');
  assert.ok(inspection.planningGaps.length > 0);
  const html = renderAtlas(profile, inspection);
  assert.match(html, /Structural profile status: VALID/);
  assert.match(html, /Planning gaps \(\d+\)/);
  assert.match(html, /Project intent basis has not been recorded/);
  assert.match(html, /Project vision or destination is empty/);
  assert.match(html, /Intended users have not been identified/);
  assert.match(html, /S-PROPOSED.*screen design is proposed and needs review/);
  assert.match(html, /J-FOCUS.*journey has no acceptance statements/);
  assert.match(html, /M-FOCUS.*milestone has no acceptance statements/);
  assert.match(html, /ST-DEPENDENT.*story has no acceptance statements/);
  assert.match(html, /M-FOCUS.*milestone has no linked story/);
  assert.match(html, /Declared priority reason/);
  assert.match(html, /Canonical execution checkpoint still selects current work/);
  assert.match(html, /OBS-FOCUS · unknown/);
  assert.match(html, /href="#node-M-FOCUS"/);
  assert.match(html, /focus\.md.*DRIFT/);
  assert.match(html, /overflow-x:hidden/);
  assert.match(html, /No scripts, remote assets/);
});

test('renderer requires generated output identity and gives actionable legacy migration error', async (t) => {
  const root = await tempRoot(t);
  const created = init(root, 'output-project', 'Output Project');
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const target = join(root, '.brain', 'atlas', 'PROJECT_ATLAS.html');

  await writeFile(target, '<!-- brain-atlas-generated:v1 -->\nlegacy snapshot\n');
  const legacy = cli(['render', '--root', root]);
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /legacy generated atlas has no embedded project identity; archive/i);
  assert.match(await readFile(target, 'utf8'), /legacy snapshot/);

  await rm(target);
  const firstRender = cli(['render', '--root', root]);
  assert.equal(firstRender.status, 0, firstRender.stderr || firstRender.stdout);
  const repeatRender = cli(['render', '--root', root]);
  assert.equal(repeatRender.status, 0, repeatRender.stderr || repeatRender.stdout);
  const generated = await readFile(target, 'utf8');
  assert.match(generated, /brain-atlas-generated:v1 projectId=output-project profileSha256=[a-f0-9]{64}/);
  await writeFile(target, generated.replace('projectId=output-project', 'projectId=another-project'));
  const conflict = cli(['render', '--root', root]);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /belongs to project another-project/i);
  assert.match(await readFile(target, 'utf8'), /projectId=another-project/);
});

test('default atlas CLI render projects canonical execution beside a different planning focus', async (t) => {
  const root = await tempRoot(t);
  const taskPath = '.brain/tasks/current.md';
  const taskText = '# Current platform work\n';
  const oldPlan = 'Historical planning source.\n';
  for (const path of ['.brain/tasks', '.brain/atlas', '.brain/workflow/contracts', '.brain/workflow/runs', '.brain/workflow/events', '.brain/workflow/artifacts', 'docs', 'src'])
    await mkdir(join(root, ...path.split('/')), { recursive: true });
  await writeFile(join(root, taskPath), taskText);
  await writeFile(join(root, 'docs/old-plan.md'), oldPlan);
  await writeFile(join(root, 'src/code.ts'), 'export {}\n');
  await writeFile(join(root, '.brain/workflow/recipes.json'), JSON.stringify({
    schema: 'brain.recipe-catalog.v1', recipes: [{
      id: 'projection-check', argv: ['node', '--version'], cwd: '.', description: 'Cover the fixture criterion.',
      criterionIds: ['scope'], evidenceScope: 'Fixture metadata only; never executed by atlas rendering.'
    }]
  }));
  await writeFile(join(root, '.brain/project.json'), JSON.stringify({
    schema: 'brain.project-setup.v1', name: 'Projection fixture', kind: 'test',
    repositories: [{ id: 'main', path: '.', purpose: 'isolated fixture' }],
    canonical: { brief: '.brain/BRIEF.md', outcome: '.brain/OUTCOME.md', acceptance: '.brain/ACCEPTANCE.md', strategy: '.brain/STRATEGY.md', decisions: '.brain/DECISIONS.md', progress: '.brain/CURRENT.md', current_work: taskPath },
    execution: { mode: 'existing_agent_sessions', automatic_dispatch: false, maximum_active_writers: 1 },
    commands_file: '.brain/workflow/recipes.json', policy_file: '.brain/policy.json', setup_status: 'adopted', note: 'Fixture only.'
  }));
  await writeFile(join(root, '.brain/workflow/contracts/CURRENT-001.json'), JSON.stringify({
    schema: 'brain.task-contract.v1', taskId: 'CURRENT-001', title: 'Current task from contract',
    authorization: { kind: 'authorized', reference: 'Fixture authorization.' }, sourceTaskRef: taskPath,
    owners: { coordinator: 'fixture', implementer: 'fixture', reviewer: 'fixture' },
    allowedPaths: ['src/code.ts'], excludedActions: [], prerequisites: [],
    criteria: [{ id: 'scope', description: 'Show current execution work.', evidenceScope: 'Fixture projection.' }],
    requiredRecipeIds: ['projection-check'], reviewRequirement: { required: false, independence: 'none' }
  }));

  const profile = emptyProfile('projection-fixture', 'Projection fixture');
  profile.sourceRefs = [{ id: 'historical-plan', path: 'docs/old-plan.md', role: 'Historical plan', sha256: sha(oldPlan) }];
  const oldFocus = sampleNode('M-06', 'milestone');
  oldFocus.sourceRefs = ['historical-plan'];
  oldFocus.acceptance = ['The historical milestone was once a planning focus.'];
  profile.nodes = [oldFocus];
  profile.focusNodeId = 'M-06';
  await saveProfile(root, profile);

  const rendered = cli(['render', '--root', root]);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  assert.match(rendered.stdout, /current task CURRENT-001/);
  const html = await readFile(join(root, '.brain/atlas/PROJECT_ATLAS.html'), 'utf8');
  assert.match(html, /Canonical current work/);
  assert.match(html, /CURRENT-001.*Current task from contract.*NOT_INITIALIZED/);
  assert.match(html, /M-06.*M-06 title.*MISMATCHED/);
});
