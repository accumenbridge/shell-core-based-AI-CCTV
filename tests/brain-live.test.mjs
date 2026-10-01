import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { startLive } from '../tools/brain-live.mjs';

test('live console refreshes project state and rejects unauthorized, stale and foreign-origin decisions', async t => {
  const base = await mkdtemp(join(tmpdir(), 'qb-brain-live-')); const root = join(base, 'project');
  await mkdir(join(root, '.brain/atlas'), { recursive: true });
  const profile = { schema: 'brain.atlas.v1', projectId: 'live-fixture', title: 'Live oversight fixture', planRevision: 1,
    updatedAt: '2026-10-01T00:00:00.000Z', intentBasis: 'Isolated HTTP test.',
    vision: { destination: 'Original intended outcome', users: ['Owner'], nonGoals: [], successSignals: [] },
    policy: { coreFirst: 'Core outcome', workInProgressLimit: 1, reviewCadence: [], nonNegotiables: [], deferRule: 'Defer unrelated work.' },
    sourceRefs: [], nodes: [], observations: [], retrospectives: [] };
  const save = () => writeFile(join(root, '.brain/atlas/project.json'), JSON.stringify(profile)); await save();
  const live = await startLive({ root, storeRoot: join(base, 'store') });
  t.after(async () => { await live.close(); const back = relative(resolve(tmpdir()), resolve(base)); assert(back && back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back)); await rm(base, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${live.token}` };
  const unauthenticated = await fetch(`${live.origin}/api/state`); assert.equal(unauthenticated.status, 401); await unauthenticated.text();
  const stateResponse = await fetch(`${live.origin}/api/state`, { headers }); assert.equal(stateResponse.status, 200);
  const cookie = stateResponse.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const first = await stateResponse.json(); assert.equal(first.plan.vision.destination, profile.vision.destination); assert(first.executionError);
  assert.equal(first.executionReadiness.status, 'NOT_READY');
  assert.equal(first.managedReadiness.managed.ready, false);
  assert.ok(first.managedReadiness.managed.reasons.some(item => item.code === 'MANAGED_PROFILE_MISSING'));
  const request = { action: 'prepare', confirm: true, projectId: first.binding.projectId, rootIdentity: first.binding.rootIdentity, expectedRevision: first.controller.revision, bindingDigest: first.bindingDigest };
  const post = (body, origin = live.origin) => fetch(`${live.origin}/api/action`, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const foreign = await post(request, 'https://unrelated.invalid'); assert.equal(foreign.status, 403); await foreign.text();
  const badCommand = await post({ ...request, argv: ['node', '-e', 'process.exit()'] }); assert.equal((await badCommand.json()).error.code, 'INVALID_ACTION');
  const wrongProject = await post({ ...request, projectId: 'other-project' }); assert.equal((await wrongProject.json()).error.code, 'PROJECT_MISMATCH');
  const unreadyPrepare = await post(request); assert.equal(unreadyPrepare.status, 409);
  assert.equal((await unreadyPrepare.json()).error.code, 'NOT_READY');
  const afterRefusal = await (await fetch(`${live.origin}/api/state`, { headers })).json();
  assert.equal(afterRefusal.controller.order, null);
  assert.equal(afterRefusal.controller.revision, 0);
  profile.planRevision++; profile.vision.destination = 'Revised intended outcome'; await save();
  const second = await (await fetch(`${live.origin}/api/state`, { headers })).json();
  assert.equal(second.plan.vision.destination, 'Revised intended outcome'); assert.notEqual(second.bindingDigest, first.bindingDigest);
  const stale = await post(request); assert.equal((await stale.json()).error.code, 'STALE_BASELINE');
  const atlas = await fetch(`${live.origin}/atlas`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(atlas.status, 200); assert.match(atlas.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.doesNotMatch(atlas.headers.get('content-security-policy'), /allow-same-origin/);
  const atlasHtml = await atlas.text();
  assert.match(atlasHtml, /Revised intended outcome/);
  assert.match(atlasHtml, /Canonical current work/);
  const page = await fetch(live.origin); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /sandbox="allow-scripts"/);
  const missing = await fetch(`${live.origin}/../../.brain/project.json`, { headers }); assert.equal(missing.status, 404); await missing.text();
});
