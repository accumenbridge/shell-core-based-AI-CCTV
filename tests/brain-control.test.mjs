import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createController as openController, hash } from '../tools/brain-control.mjs';
import { CodexProposalAdapter } from '../tools/brain-app-server.mjs';

const ownedControllers = new Set();
async function createController(options) {
  const controller = await openController(options);
  ownedControllers.add({ controller, store: options.storeRoot });
  return controller;
}

async function put(root, path, value) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
const proposedHtml = '<!doctype html><html><head><title>Trip stops</title></head><body><h1>Trip stops</h1><p id="count" aria-live="polite">0</p><button id="add">Add a stop</button><script>let count=0;document.getElementById("add").addEventListener("click",()=>{document.getElementById("count").textContent=String(++count)});</script></body></html>';
async function fixture(t, projectId = 'managed-fixture') {
  const base = await mkdtemp(join(tmpdir(), 'qb-brain-control-')); const root = join(base, 'project'); const store = join(base, 'store');
  t.after(async () => {
    for (const entry of ownedControllers) if (entry.store === store) { await entry.controller.close(); ownedControllers.delete(entry); }
    const back = relative(resolve(tmpdir()), resolve(base)); assert(back && back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back));
    await rm(base, { recursive: true, force: true });
  });
  const taskId = 'DEMO-001';
  const profile = { schema: 'brain.atlas.v1', projectId, title: 'Trip stops', planRevision: 1, updatedAt: '2026-10-01T00:00:00.000Z', intentBasis: 'Explicit isolated test project.',
    vision: { destination: 'A visitor can add trip stops and see the count.', users: ['Visitor'], nonGoals: ['Bookings'], successSignals: [] },
    policy: { coreFirst: 'One usable behavior.', workInProgressLimit: 1, reviewCadence: [], nonNegotiables: [], deferRule: 'Defer unrelated changes.' },
    nodes: [{ id: 'SCREEN-1', kind: 'screen', title: 'Trip stop counter', summary: 'Visible count and keyboard-accessible Add a stop button.', owner: 'Fixture owner',
      intentStatus: 'accepted', priority: 'core', priorityReason: 'Complete the visitor action.', dependsOn: [], links: [], sourceRefs: ['current-task'], acceptance: ['Initial count is zero; each activation increases it by one.'] }],
    sourceRefs: [{ id: 'current-task', path: '.brain/tasks/DEMO-001.md', role: 'Canonical authorized task', sha256: hash('# Add stop count\n') }],
    focusNodeId: 'SCREEN-1', observations: [], retrospectives: [] };
  await put(root, '.brain/atlas/project.json', profile);
  await put(root, '.brain/project.json', { schema: 'brain.project-setup.v1', name: 'Trip stops', kind: 'fixture', repositories: [{ id: 'main', path: '.', purpose: 'Fixture' }],
    canonical: { brief: '.brain/brief.md', outcome: '.brain/outcome.md', acceptance: '.brain/acceptance.md', strategy: '.brain/strategy.md', decisions: '.brain/decisions.md', progress: '.brain/CURRENT.md', current_work: '.brain/tasks/DEMO-001.md' },
    execution: { mode: 'existing_agent_sessions', automatic_dispatch: false, maximum_active_writers: 1 }, commands_file: '.brain/workflow/recipes.json', policy_file: '.brain/policy.json', setup_status: 'adopted', note: 'Fixture' });
  await put(root, '.brain/tasks/DEMO-001.md', '# Add stop count\n');
  await put(root, '.brain/workflow/contracts/DEMO-001.json', { schema: 'brain.task-contract.v1', taskId, title: 'Add interactive stop count', authorization: { kind: 'authorized', reference: 'Isolated test contract' },
    sourceTaskRef: '.brain/tasks/DEMO-001.md', owners: { coordinator: 'fixture', implementer: 'fixture agent', reviewer: 'fixture human' }, allowedPaths: ['index.html'], excludedActions: [], prerequisites: [],
    criteria: [{ id: 'behavior', description: 'Add a stop increments visible count.', evidenceScope: 'Actual browser plus fixed checks.' }], requiredRecipeIds: ['fixture-check'], reviewRequirement: { required: false, independence: 'none' } });
  await put(root, '.brain/workflow/recipes.json', { schema: 'brain.recipe-catalog.v1', recipes: [{ id: 'fixture-check', argv: ['node', '--test', 'check.test.mjs'], cwd: '.', description: 'Fixture check', criterionIds: ['behavior'], evidenceScope: 'Fixture' }] });
  await put(root, '.brain/control/DEMO-001.json', { schema: 'brain.control-profile.v1', taskId, inputPaths: ['index.html', 'build.mjs', 'check.test.mjs'],
    checks: [{ id: 'build', kind: 'build', script: 'build.mjs' }, { id: 'behavior', kind: 'test', script: 'check.test.mjs' }], previewPath: 'index.html', planNodeIds: ['SCREEN-1'] });
  await put(root, 'index.html', '<!doctype html><html><body><h1>Trip stops</h1><p id="count">0</p><button id="add" disabled>Add a stop</button></body></html>');
  await put(root, 'build.mjs', 'import {readFile} from "node:fs/promises"; import {Script} from "node:vm"; const html=await readFile("index.html","utf8"); if(!html.startsWith("<!doctype html>"))throw Error("Missing document"); for(const part of html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)) new Script(part[1]); console.log("Built static document: inline scripts parse.");');
  await put(root, 'check.test.mjs', 'import test from "node:test"; import assert from "node:assert/strict"; import {readFile} from "node:fs/promises"; import {runInNewContext} from "node:vm"; test("two activations count two stops",async()=>{const html=await readFile("index.html","utf8");let click;const count={textContent:"0"};const button={addEventListener:(event,fn)=>{assert.equal(event,"click");click=fn}};const document={getElementById:id=>id==="add"?button:count};const script=html.match(/<script>([\\s\\S]*?)<\\/script>/)?.[1];assert(script);runInNewContext(script,{document},{timeout:1000});assert.equal(count.textContent,"0");click();assert.equal(count.textContent,"1");click();assert.equal(count.textContent,"2");});');
  return { root, store, base, profile };
}
const adapter = edits => ({ propose: async ({ onActivity }) => { await onActivity({ type: 'fixture-agent', text: 'Returning deterministic test proposal.' }); return { status: 'completed', summary: 'Interactive stop counter.', edits: edits ?? [{ path: 'index.html', content: proposedHtml }] }; }, interrupt: async () => {}, close: async () => {} });
async function request(controller, action, extra = {}) { const s = await controller.snapshot(); return { action, confirm: true, projectId: s.binding.projectId, rootIdentity: s.binding.rootIdentity, expectedRevision: s.controller.revision, bindingDigest: s.bindingDigest, orderId: s.controller.order?.id, candidateDigest: s.controller.order?.candidate?.digest, ...extra }; }

test('managed feature edits only its candidate, observes real checks and requires a current review', async t => {
  const { root, store } = await fixture(t); const original = await readFile(join(root, 'index.html'));
  const controller = await createController({ root, storeRoot: store, adapter: adapter() }); t.after(() => controller.close());
  await controller.action(await request(controller, 'prepare'));
  await controller.action(await request(controller, 'start')); await controller.waitForIdle();
  const s = await controller.snapshot(); assert.equal(s.controller.order.status, 'REVIEW', JSON.stringify(s.controller.order));
  assert.equal(s.managedReadiness.managed.ready, true);
  assert.equal(s.canonicalProjection.taskId, 'DEMO-001');
  assert.equal(s.canonicalProjection.focusNodeId, 'SCREEN-1');
  assert.deepEqual(s.controller.order.checks.map(c => [c.id, c.status]), [['build', 'PASSED'], ['behavior', 'PASSED']]);
  assert.deepEqual(await readFile(join(root, 'index.html')), original);
  assert.match((await controller.preview()).toString(), /addEventListener/);
  await assert.rejects(controller.action(await request(controller, 'accept', { candidateDigest: '0'.repeat(64), text: 'Reviewed fixture.' })), { code: 'STALE_CANDIDATE' });
  await controller.action(await request(controller, 'accept', { text: 'Fixture human review; real browser qualification is separate.' }));
  assert.equal((await controller.snapshot()).controller.order.status, 'ACCEPTED');
  await controller.close();
  const reopened = await createController({ root, storeRoot: store }); t.after(() => reopened.close());
  assert.equal((await reopened.snapshot()).controller.order.status, 'ACCEPTED');
});

test('whole proposal validation prevents partial out-of-scope changes', async t => {
  const { root, store } = await fixture(t);
  const controller = await createController({ root, storeRoot: store, adapter: adapter([{ path: 'index.html', content: proposedHtml }, { path: '../authority.json', content: 'bad' }]) }); t.after(() => controller.close());
  await controller.action(await request(controller, 'prepare')); const prepared = await controller.snapshot();
  await controller.action(await request(controller, 'start')); await controller.waitForIdle();
  assert.equal((await controller.snapshot()).controller.order.status, 'FAILED');
  assert.deepEqual(await readFile(join(store, 'orders', prepared.controller.order.id, 'candidate/index.html')), await readFile(join(root, 'index.html')));
});

test('source drift, stale decisions and cross-project replay are rejected', async t => {
  const a = await fixture(t, 'alpha'); const b = await fixture(t, 'beta');
  const ca = await createController({ root: a.root, storeRoot: a.store, adapter: adapter() }); t.after(() => ca.close());
  const cb = await createController({ root: b.root, storeRoot: b.store, adapter: adapter() }); t.after(() => cb.close());
  const decision = await request(ca, 'prepare');
  await assert.rejects(cb.action(decision), { code: 'PROJECT_MISMATCH' });
  await ca.action(decision); await assert.rejects(ca.action(decision), { code: 'STALE_DECISION' });
  await writeFile(join(a.root, 'build.mjs'), 'console.log("changed build")');
  await assert.rejects(ca.action(await request(ca, 'start')), { code: 'STALE_INPUT' });
  await assert.rejects(createController({ root: b.root, storeRoot: a.store }), { code: 'PROJECT_MISMATCH' });
});

test('managed readiness is shared, preserves observation, refuses drift before effects and recovers only after explicit reconciliation', async t => {
  const { root, store, profile } = await fixture(t);
  await put(root, 'future.md', 'Unselected future design.\n');
  profile.sourceRefs.push({ id: 'future', path: 'future.md', role: 'Unselected future note', sha256: hash('old future bytes\n') });
  await put(root, '.brain/atlas/project.json', profile);
  let proposals = 0;
  const localAdapter = { propose: async () => { proposals++; return { status: 'completed', edits: [{ path: 'index.html', content: proposedHtml }] }; }, interrupt: async () => {}, close: async () => {} };
  const controller = await createController({ root, storeRoot: store, adapter: localAdapter }); t.after(() => controller.close());
  const initial = await controller.snapshot();
  assert.equal(initial.plan.sourceStatus, 'DEGRADED');
  assert.equal(initial.managedReadiness.managed.ready, true, 'unrelated future source drift remains advisory before preparation');
  await controller.action(await request(controller, 'prepare'));
  const prepared = await controller.snapshot();
  const eventNames = await readdir(join(store, 'events'));
  const orderNames = await readdir(join(store, 'orders'));

  await writeFile(join(root, '.brain/tasks/DEMO-001.md'), '# Revised current task\n');
  const drifted = await controller.snapshot();
  assert.equal(drifted.managedReadiness.managed.ready, false);
  assert.ok(drifted.managedReadiness.managed.reasons.some(item => item.code === 'GOVERNING_SOURCE_NOT_CURRENT'));
  await assert.rejects(controller.action(await request(controller, 'prepare')), { code: 'NOT_READY' });
  await assert.rejects(controller.action(await request(controller, 'start')), { code: 'NOT_READY' });
  assert.deepEqual(await readdir(join(store, 'events')), eventNames);
  assert.deepEqual(await readdir(join(store, 'orders')), orderNames);
  assert.equal(proposals, 0);
  assert.equal((await controller.snapshot()).controller.order.id, prepared.controller.order.id);

  await writeFile(join(root, '.brain/control/DEMO-001.json'), '{broken json');
  const malformed = await controller.snapshot();
  assert.equal(malformed.managedProfileStatus, 'INVALID');
  assert.equal(malformed.managedReadiness.managed.ready, false);
  assert.match(malformed.managedProfileError, /JSON|position|property/i);

  profile.planRevision++;
  profile.updatedAt = '2026-10-01T01:00:00.000Z';
  profile.sourceRefs.find(source => source.id === 'current-task').sha256 = hash('# Revised current task\n');
  await put(root, '.brain/control/DEMO-001.json', { schema: 'brain.control-profile.v1', taskId: 'DEMO-001', inputPaths: ['index.html', 'build.mjs', 'check.test.mjs'],
    checks: [{ id: 'build', kind: 'build', script: 'build.mjs' }, { id: 'behavior', kind: 'test', script: 'check.test.mjs' }], previewPath: 'index.html', planNodeIds: ['SCREEN-1'] });
  await put(root, '.brain/atlas/project.json', profile);
  const reconciled = await controller.snapshot();
  assert.equal(reconciled.managedReadiness.managed.ready, true);
  await controller.action(await request(controller, 'prepare'));
  assert.equal((await controller.snapshot()).controller.order.status, 'PREPARED');
});

test('an accepted focus linked to another task cannot prepare managed work', async t => {
  const { root, store, profile } = await fixture(t);
  await put(root, '.brain/tasks/OTHER-001.md', '# Different task\n');
  profile.sourceRefs.push({ id: 'other-task', path: '.brain/tasks/OTHER-001.md', role: 'Different task', sha256: hash('# Different task\n') });
  profile.nodes[0].sourceRefs = ['other-task']; profile.planRevision++;
  await put(root, '.brain/atlas/project.json', profile);
  const controller = await createController({ root, storeRoot: store, adapter: adapter() }); t.after(() => controller.close());
  const state = await controller.snapshot();
  assert.equal(state.managedReadiness.ready, false);
  assert.ok(state.managedReadiness.reasons.some(item => item.code === 'FOCUS_NOT_LINKED_TO_CURRENT_TASK'));
  await assert.rejects(controller.action(await request(controller, 'prepare')), { code: 'NOT_READY' });
  assert.deepEqual(await readdir(join(store, 'events')), []);
  assert.deepEqual(await readdir(join(store, 'orders')), []);
});

test('pause and direction changes wait for acknowledgement and discard late output', async t => {
  const { root, store } = await fixture(t); let release; let interrupted = false;
  const delayed = { propose: async () => new Promise(resolve => { release = resolve; }), interrupt: async () => { interrupted = true; }, close: async () => {} };
  const controller = await createController({ root, storeRoot: store, adapter: delayed }); t.after(() => controller.close());
  await controller.action(await request(controller, 'prepare')); await controller.action(await request(controller, 'start'));
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await controller.action(await request(controller, 'steer', { text: 'Keep this bounded journey; reconsider wording before proceeding.' }));
  assert.equal((await controller.snapshot()).controller.order.status, 'STOPPING'); assert.equal(interrupted, true);
  release({ status: 'completed', edits: [{ path: 'index.html', content: proposedHtml }], summary: 'Too late.' }); await controller.waitForIdle();
  const s = await controller.snapshot(); assert.equal(s.controller.order.status, 'PAUSED'); assert.equal(s.controller.order.candidate, null);
  assert.equal((await readdir(join(store, 'orders', s.controller.order.id))).includes('proposal.json'), false);
});

test('failed actual check is retained and cannot be accepted', async t => {
  const { root, store } = await fixture(t); const controller = await createController({ root, storeRoot: store, adapter: adapter([{ path: 'index.html', content: '<!doctype html><html><body>Missing behavior</body></html>' }]) }); t.after(() => controller.close());
  await controller.action(await request(controller, 'prepare')); await controller.action(await request(controller, 'start')); await controller.waitForIdle();
  const s = await controller.snapshot(); assert.equal(s.controller.order.status, 'FAILED'); assert.equal(s.controller.order.checks[1].status, 'FAILED');
  assert.match(s.controller.order.checks[1].output, /not ok/);
  await assert.rejects(controller.action(await request(controller, 'accept', { text: 'Cannot approve failed checks.' })), { code: 'NOT_VERIFIED' });
});

test('lost agent connection preserves UNKNOWN and never silently redispatches', async t => {
  const { root, store } = await fixture(t); let calls = 0;
  const broken = { propose: async () => { calls++; throw Object.assign(new Error('Disconnected'), { code: 'CONNECTION_LOST' }); }, close: async () => {} };
  const controller = await createController({ root, storeRoot: store, adapter: broken });
  await controller.action(await request(controller, 'prepare')); await controller.action(await request(controller, 'start')); await controller.waitForIdle();
  assert.equal((await controller.snapshot()).controller.order.status, 'UNKNOWN'); await controller.close();
  const reopened = await createController({ root, storeRoot: store, adapter: broken }); t.after(() => reopened.close());
  assert.equal((await reopened.snapshot()).controller.order.status, 'UNKNOWN'); assert.equal(calls, 1);
  await assert.rejects(reopened.action(await request(reopened, 'prepare')), { code: 'BUSY' });
});

test('changed architecture source invalidates review even outside editable inputs', async t => {
  const { root, store, profile } = await fixture(t);
  await put(root, 'architecture.md', 'Approved stop counting behavior.');
  profile.sourceRefs.push({ id: 'architecture', path: 'architecture.md', role: 'Design authority', sha256: hash('Approved stop counting behavior.') });
  profile.nodes[0].sourceRefs.push('architecture');
  await put(root, '.brain/atlas/project.json', profile);
  const controller = await createController({ root, storeRoot: store, adapter: adapter() });
  await controller.action(await request(controller, 'prepare')); await controller.action(await request(controller, 'start')); await controller.waitForIdle();
  assert.equal((await controller.snapshot()).controller.order.status, 'REVIEW');
  const approval = await request(controller, 'accept', { text: 'Reviewed previous architecture.' });
  await put(root, 'architecture.md', 'Changed expected behavior.');
  await assert.rejects(controller.action(approval), { code: 'STALE_BASELINE' });
  await assert.rejects(controller.action(await request(controller, 'accept', { text: 'Refreshed page is insufficient to rebind the old candidate.' })), { code: 'NOT_READY' });
});

test('App Server ambiguous turn acknowledgement and protocol loss remain uncertain', async () => {
  for (const mode of ['timeout', 'protocol', 'rejected']) {
    let killed = false;
    const agent = new CodexProposalAdapter();
    agent.process = { kill: () => { killed = true; } };
    agent.initialize = async () => ({});
    agent.rpc = async method => {
      if (method === 'thread/start') return { thread: { id: 'owned-thread' } };
      if (mode === 'protocol') agent.lost(Object.assign(new Error('Malformed message'), { code: 'PROTOCOL_ERROR' }));
      throw Object.assign(new Error(mode), { code: mode === 'rejected' ? 'APP_SERVER_ERROR' : 'RPC_TIMEOUT' });
    };
    await assert.rejects(agent.propose({ cwd: '.', task: { allowedPaths: ['index.html'] } }), { code: mode === 'rejected' ? 'APP_SERVER_ERROR' : 'CONNECTION_LOST' });
    assert.equal(killed, mode !== 'rejected');
    assert.equal(agent.active, null);
  }
});

test('proposal adapter interrupts unknown item types instead of authorizing future tools', async () => {
  const agent = new CodexProposalAdapter(); let interrupted = false;
  agent.interrupt = async () => { interrupted = true; };
  agent.active = { threadId: 'owned-thread', onActivity: () => {} };
  agent.message({ method: 'item/started', params: { threadId: 'owned-thread', item: { type: 'futureToolExecution' } } });
  assert.equal(interrupted, true); assert.match(agent.active.violation, /futureToolExecution/);
});
