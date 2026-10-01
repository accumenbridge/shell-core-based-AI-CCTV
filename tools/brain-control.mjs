import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalJson, context } from './brain-core.mjs';
import { inspectAtlas } from './brain-atlas.mjs';
import { assessReadiness } from './brain-readiness.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const active = new Set(['RUNNING', 'APPLYING', 'CHECKING', 'STOPPING']);
const limit = 1024 * 1024;
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') || value.includes(':') || /[\x00-\x1f]/.test(value) ||
      isAbsolute(value) || win32.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', 'Expected an exact project-relative path.');
  return value;
}
export async function safeFile(root, path, optional = false) {
  relativePath(path);
  let cursor = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    let info;
    try { info = await lstat(cursor); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links are not supported in managed inputs.');
    if (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()) fail('UNSAFE_PATH', `Unexpected path type: ${path}`);
    if (i === parts.length - 1 && info.size > limit) fail('TOO_LARGE', `Managed file exceeds 1 MiB: ${path}`);
  }
  return readFile(cursor);
}
async function readJson(root, path) { return JSON.parse(await safeFile(root, path)); }
async function capture(root, paths, optional = []) {
  const files = []; let bytes = 0;
  for (const path of [...new Set(paths)].sort()) {
    const content = await safeFile(root, path, optional.includes(path));
    bytes += content?.length ?? 0;
    if (bytes > 4 * limit) fail('TOO_LARGE', 'Managed input closure exceeds 4 MiB.');
    files.push({ path, sha256: content === null ? null : hash(content) });
  }
  return { files, digest: hash(files) };
}
async function tree(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    relativePath(path);
    if (entry.isSymbolicLink()) fail('UNSAFE_PATH', 'A managed candidate contains a symbolic link.');
    if (entry.isDirectory()) files.push(...await tree(root, path));
    else if (entry.isFile()) files.push(path);
    else fail('UNSAFE_PATH', 'A managed candidate contains a special file.');
    if (files.length > 512) fail('TOO_LARGE', 'Managed candidate exceeds 512 files.');
  }
  return files;
}
const authorityPath = path => /^(?:\.brain|\.git|\.codex|\.local)(?:\/|$)/i.test(path) || /(?:^|\/)AGENTS\.md$/i.test(path);

export async function projectSnapshot(rootInput) {
  const root = await realpath(resolve(rootInput));
  const atlas = await inspectAtlas(root);
  let execution = null; let executionError = null;
  try { execution = await context(root); } catch (error) { executionError = { code: error.code ?? 'UNAVAILABLE', message: error.message }; }
  const rootIdentity = hash({ root: process.platform === 'win32' ? root.toLowerCase() : root, projectId: atlas.projectId });
  const binding = {
    projectId: atlas.projectId, rootIdentity, planRevision: atlas.profile.planRevision, planDigest: atlas.profileDigest,
    sourceInspectionDigest: hash(atlas.sourceChecks),
    checkpointRevision: execution?.checkpoint?.pointer.revision ?? null, checkpointDigest: execution?.checkpoint?.pointer.eventSha256 ?? null,
    taskId: execution?.selectedTaskId ?? null, contractDigest: execution?.contractDigest ?? null, candidateDigest: execution?.candidate?.digest ?? null
  };
  const value = {
    observedAt: new Date().toISOString(), root, binding, bindingDigest: hash(binding),
    plan: { title: atlas.profile.title, vision: atlas.profile.vision, focusNodeId: atlas.profile.focusNodeId,
      nodes: atlas.profile.nodes, sourceRefs: atlas.profile.sourceRefs, observations: atlas.profile.observations, structuralStatus: atlas.structuralStatus,
      sourceStatus: atlas.sourceStatus, sourceChecks: atlas.sourceChecks, gaps: atlas.planningGaps, errors: atlas.errors },
    execution: execution ? { taskId: execution.selectedTaskId, contract: execution.contract, candidate: execution.candidate,
      checkpoint: execution.checkpoint, evidenceAssessment: execution.evidenceAssessment,
      executionReadiness: execution.executionReadiness,
      missingPlannedPaths: execution.missingPlannedPaths ?? [], records: execution.records.filter(record => record.taskId === execution.selectedTaskId),
      limitations: execution.limitations } : null, executionError
  };
  let profile = null; let managedProfileStatus = 'MISSING'; let managedProfileError = null;
  if (binding.taskId) {
    try {
      const bytes = await safeFile(root, `.brain/control/${binding.taskId}.json`, true);
      if (bytes) {
        try { profile = JSON.parse(bytes.toString('utf8')); managedProfileStatus = 'INVALID'; }
        catch (error) { managedProfileStatus = 'INVALID'; managedProfileError = error.message; }
      }
    } catch (error) { managedProfileStatus = 'INVALID'; managedProfileError = error.message; }
  }
  if (profile && execution?.contract) {
    try { validateProfile(profile, execution.contract, value.plan); managedProfileStatus = 'VALID'; }
    catch (error) { managedProfileStatus = 'INVALID'; managedProfileError = error.message; }
  } else if (profile) {
    managedProfileStatus = 'INVALID'; managedProfileError = 'The canonical current task contract is unavailable.';
  }
  value.managedReadiness = assessReadiness({
    atlas: { present: true, profile: atlas.profile, structuralStatus: atlas.structuralStatus, sourceChecks: atlas.sourceChecks },
    task: execution?.readinessContext?.task ?? {},
    managedProfile: { status: managedProfileStatus, planNodeIds: managedProfileStatus === 'VALID' ? profile.planNodeIds : [] }
  });
  value.executionReadiness = execution?.executionReadiness ?? value.managedReadiness;
  value.canonicalProjection = value.executionReadiness.projection;
  value.managedProfileAvailable = managedProfileStatus === 'VALID';
  value.managedProfileStatus = managedProfileStatus;
  if (managedProfileError) value.managedProfileError = String(managedProfileError).slice(0, 300);
  return value;
}

function validateProfile(profile, contract, plan) {
  if (profile.schema !== 'brain.control-profile.v1' || profile.taskId !== contract.taskId) fail('INVALID_PROFILE', 'Control profile must name the selected task.');
  if (Object.keys(profile).some(key => !['schema', 'taskId', 'inputPaths', 'checks', 'previewPath', 'planNodeIds'].includes(key))) fail('INVALID_PROFILE', 'Unsupported control profile field.');
  if (!Array.isArray(profile.inputPaths) || !profile.inputPaths.length || profile.inputPaths.length > 256 || new Set(profile.inputPaths).size !== profile.inputPaths.length) fail('INVALID_PROFILE', 'Declare a bounded, unique input closure.');
  for (const path of profile.inputPaths) { relativePath(path); if (authorityPath(path)) fail('INVALID_PROFILE', 'Project authority cannot enter the worker candidate.'); }
  for (const path of contract.allowedPaths) if (authorityPath(path) || !profile.inputPaths.includes(path)) fail('INVALID_PROFILE', 'Every editable path must be a non-authority input.');
  if (!Array.isArray(profile.planNodeIds) || !profile.planNodeIds.length || profile.planNodeIds.some(id => !plan.nodes.some(node => node.id === id && node.intentStatus === 'accepted' && node.acceptance.length))) fail('INVALID_PROFILE', 'Link approved plan nodes with observable acceptance.');
  if (!Array.isArray(profile.checks) || profile.checks.length < 2 || profile.checks.length > 8 || profile.checks[0].kind !== 'build' || !profile.checks.some(check => check.kind === 'test')) fail('INVALID_PROFILE', 'Fixed checks must build first and include a test.');
  const ids = new Set();
  for (const check of profile.checks) {
    if (Object.keys(check).some(key => !['id', 'kind', 'script'].includes(key)) || !/^[a-z][a-z0-9-]{0,63}$/.test(check.id) || ids.has(check.id) || !['build', 'test'].includes(check.kind)) fail('INVALID_PROFILE', 'Invalid fixed Node check.');
    ids.add(check.id); relativePath(check.script);
    if (!/\.(?:mjs|cjs|js)$/.test(check.script) || !profile.inputPaths.includes(check.script) || contract.allowedPaths.includes(check.script)) fail('INVALID_PROFILE', 'Verification scripts must be captured inputs outside worker edit scope.');
  }
  if (profile.previewPath !== null && (!profile.inputPaths.includes(profile.previewPath) || !profile.previewPath.endsWith('.html'))) fail('INVALID_PROFILE', 'Preview must be one declared HTML input.');
  return profile;
}

export async function createController({ root: rootInput, storeRoot, adapter = null }) {
  const root = await realpath(resolve(rootInput));
  const first = await projectSnapshot(root);
  if (!first.binding.projectId) fail('INVALID_PROJECT', 'An atlas project identity is required.');
  const store = resolve(storeRoot);
  // Store location is selected by the host, never by browser input or a model.
  await mkdir(store, { recursive: true });
  if ((await lstat(store)).isSymbolicLink() || await realpath(store) !== store) fail('UNSAFE_STORE', 'Store must resolve to its explicit canonical path.');
  const identity = { schema: 'brain.control-store.v1', projectId: first.binding.projectId, rootIdentity: first.binding.rootIdentity };
  try { await writeFile(join(store, 'identity.json'), JSON.stringify(identity), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (canonicalJson(await readJson(store, 'identity.json')) !== canonicalJson(identity)) fail('PROJECT_MISMATCH', 'This controller store belongs to another project/root.'); }
  const lockToken = randomUUID();
  try { await writeFile(join(store, 'writer.lock'), lockToken, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') fail('STORE_LOCKED', 'Controller already owned or interrupted. Reconcile its owner; locks are never stolen automatically.'); throw error; }
  let state = { ...identity, revision: 0, lastDigest: null, order: null, direction: null };
  let queue = Promise.resolve(); let worker = null; let checkChild = null; let closed = false;
  const serial = fn => { const pending = queue.then(fn); queue = pending.catch(() => {}); return pending; };
  const commit = async (type, patch = {}) => {
    const next = { ...state, ...patch, revision: state.revision + 1 };
    const event = { schema: 'brain.control-event.v1', ...identity, revision: next.revision, previousDigest: state.lastDigest,
      at: new Date().toISOString(), type, state: { ...next, lastDigest: null } };
    const digest = hash(event);
    await writeFile(join(store, 'events', `${String(next.revision).padStart(8, '0')}.json`), JSON.stringify({ ...event, digest }, null, 2), { flag: 'wx' });
    state = { ...next, lastDigest: digest };
  };
  try {
    await mkdir(join(store, 'events'), { recursive: true });
    await mkdir(join(store, 'orders'), { recursive: true });
    const entries = (await readdir(join(store, 'events'))).sort();
    if (entries.length > 10000) fail('TOO_LARGE', 'Controller event history exceeds this local profile.');
    for (const name of entries) {
      if (name !== `${String(state.revision + 1).padStart(8, '0')}.json`) fail('EVENT_INTEGRITY', 'Controller event sequence is incomplete.');
      const event = await readJson(store, `events/${name}`);
      const { digest, ...unsigned } = event;
      if (hash(unsigned) !== digest || event.previousDigest !== state.lastDigest || event.projectId !== identity.projectId || event.rootIdentity !== identity.rootIdentity || event.revision !== state.revision + 1) fail('EVENT_INTEGRITY', 'Controller event binding or hash is invalid.');
      state = { ...event.state, lastDigest: digest };
    }
    if (active.has(state.order?.status)) await commit('restart-uncertainty', { order: { ...state.order, status: 'UNKNOWN', error: 'Previous execution was interrupted; no automatic redispatch.' } });
  } catch (error) { await unlink(join(store, 'writer.lock')); throw error; }

  const orderDir = order => join(store, 'orders', order.id);
  const candidateDir = order => join(orderDir(order), 'candidate');
  async function verifyOrder(order) {
    const current = await projectSnapshot(root);
    if (!current.managedReadiness.managed.ready) fail('NOT_READY', 'Managed work no longer matches the current canonical plan and task.', { readiness: current.managedReadiness });
    if (current.bindingDigest !== order.bindingDigest) fail('STALE_BASELINE', 'Project plan, checkpoint, contract or source changed. Prepare a new order.');
    const profile = await readJson(root, `.brain/control/${order.taskId}.json`);
    if (hash(profile) !== order.profileDigest || (await capture(root, profile.inputPaths, order.allowedPaths)).digest !== order.input.digest) fail('STALE_INPUT', 'A captured input or execution profile changed.');
  }
  async function snapshot() {
    const project = await projectSnapshot(root);
    const current = clone(state);
    let staleOrder = false;
    if (current.order) { try { await verifyOrder(current.order); } catch { staleOrder = true; } }
    return { ...project, controller: current, staleOrder, adapterAvailable: Boolean(adapter),
      limits: ['Only this controller’s managed proposals can be paused or accepted.', 'Canonical platform progress is observed; controller acceptance does not update it.', 'This is a local developer process, not a proven hostile-user sandbox.'] };
  }
  async function checkRequest(request) {
    if (closed) fail('CLOSED', 'Controller is closed.');
    if (request.projectId !== identity.projectId || request.rootIdentity !== identity.rootIdentity) fail('PROJECT_MISMATCH', 'Decision targets another project or root.');
    if (request.expectedRevision !== state.revision) fail('STALE_DECISION', 'Controller changed; refresh before acting.');
    if (request.confirm !== true) fail('CONFIRMATION_REQUIRED', 'Explicit confirmation is required.');
    if (request.action !== 'pause' && request.action !== 'steer') {
      const current = await projectSnapshot(root);
      if (request.bindingDigest !== current.bindingDigest) fail('STALE_BASELINE', 'Displayed project binding changed; refresh before acting.');
    }
    if (request.action !== 'prepare' && request.orderId !== state.order?.id) fail('ORDER_MISMATCH', 'Decision targets another order.');
  }
  async function prepare() {
    if (active.has(state.order?.status) || state.order?.status === 'UNKNOWN') fail('BUSY', 'Reconcile uncertain execution before preparing another order.');
    const current = await projectSnapshot(root);
    if (!current.managedReadiness.managed.ready) fail('NOT_READY', 'Managed preparation requires current canonical task and plan readiness.', { readiness: current.managedReadiness });
    if (current.executionError || current.plan.structuralStatus !== 'VALID' || current.execution?.contract?.authorization.kind !== 'authorized') fail('NOT_READY', 'A valid authorized task and project plan are required.');
    const contract = current.execution.contract;
    const profile = validateProfile(await readJson(root, `.brain/control/${contract.taskId}.json`), contract, current.plan);
    const input = await capture(root, profile.inputPaths, contract.allowedPaths);
    const order = { id: randomUUID(), taskId: contract.taskId, title: contract.title, status: 'PREPARED',
      binding: current.binding, bindingDigest: current.bindingDigest, profile, profileDigest: hash(profile), input,
      allowedPaths: contract.allowedPaths, criteria: contract.criteria, nodes: current.plan.nodes.filter(node => profile.planNodeIds.includes(node.id)),
      direction: state.direction, activity: [], checks: [], candidate: null, summary: null, error: null, preparedAt: new Date().toISOString() };
    await mkdir(candidateDir(order), { recursive: true });
    for (const file of input.files) {
      if (file.sha256 === null) continue;
      const content = await safeFile(root, file.path);
      if (hash(content) !== file.sha256) fail('STALE_INPUT', 'Input changed while copying.');
      await mkdir(dirname(join(candidateDir(order), file.path)), { recursive: true });
      await writeFile(join(candidateDir(order), file.path), content, { flag: 'wx' });
    }
    await verifyOrder(order);
    await commit('order-prepared', { order });
  }
  async function activity(id, message) {
    await serial(async () => {
      if (state.order?.id !== id || !active.has(state.order.status)) return;
      const item = { at: new Date().toISOString(), type: String(message.type ?? 'activity').slice(0, 80), text: String(message.text ?? '').slice(0, 600) };
      await commit('observed-agent-activity', { order: { ...state.order, activity: [...state.order.activity.slice(-79), item] } });
    });
  }
  async function runCheck(order, check, sourceBefore) {
    const cwd = candidateDir(order);
    const argv = check.kind === 'test' ? ['--test', '--test-reporter=tap', check.script] : [check.script];
    const startedAt = new Date().toISOString();
    let stdout = ''; let stderr = ''; let timedOut = false; let exceeded = false;
    let child;
    const result = await new Promise(resolveRun => {
      child = spawn(process.execPath, argv, { cwd, shell: false, windowsHide: true,
        env: { PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' } });
      checkChild = child;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
      const collect = (kind, chunk) => {
        const text = chunk.toString();
        if ((stdout.length + stderr.length + text.length) > 256 * 1024) { exceeded = true; child.kill(); return; }
        if (kind === 'stdout') stdout += text; else stderr += text;
      };
      child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
      child.once('error', error => { clearTimeout(timer); resolveRun({ exitCode: null, signal: null, error: error.message }); });
      child.once('close', (exitCode, signal) => { clearTimeout(timer); resolveRun({ exitCode, signal }); });
    });
    checkChild = null;
    const interruptionRequested = child.brainInterrupted === true;
    let sourceAfter = null; let sourceError = null;
    try { sourceAfter = await capture(cwd, order.profile.inputPaths, order.allowedPaths); } catch (error) { sourceError = error.message; }
    const counts = check.kind === 'test' ? Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, Number(stdout.match(new RegExp(`^# ${key} (\\d+)\\s*$`, 'm'))?.[1] ?? -1)])) : null;
    const passed = result.exitCode === 0 && !result.signal && !timedOut && !exceeded && !interruptionRequested && sourceAfter?.digest === sourceBefore.digest && (!counts || (counts.tests > 0 && counts.pass === counts.tests && ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0)));
    const evidence = { schema: 'brain.observed-check.v1', projectId: identity.projectId, rootIdentity: identity.rootIdentity,
      orderId: order.id, bindingDigest: order.bindingDigest, candidateBefore: order.candidate, checkId: check.id,
      command: { executable: process.execPath, argv, cwd }, startedAt, endedAt: new Date().toISOString(), ...result, timedOut, exceeded,
      counts, sourceBefore, sourceAfter, sourceError, interruptionRequested,
      status: interruptionRequested || timedOut || exceeded || result.signal ? 'UNKNOWN' : passed ? 'PASSED' : 'FAILED', stdout, stderr, provenance: 'controller-observed-process' };
    await writeFile(join(orderDir(order), `${check.id}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx' });
    return { id: check.id, status: evidence.status, exitCode: result.exitCode, signal: result.signal, counts, evidenceDigest: hash(evidence),
      output: `${stdout}\n${stderr}`.slice(-16000), limitation: 'Observed local process; not a hostile-code sandbox.' };
  }
  async function execute(id) {
    try {
      let order = clone(state.order);
      const files = [];
      for (const file of order.input.files) files.push({ path: file.path, content: file.sha256 === null ? null : (await safeFile(candidateDir(order), file.path)).toString('utf8') });
      let proposal;
      await serial(async () => {
        if (state.order?.id !== id || state.order.status !== 'RUNNING') return;
        proposal = adapter.propose({ cwd: candidateDir(order), task: { title: order.title, criteria: order.criteria, nodes: order.nodes,
          allowedPaths: order.allowedPaths, direction: order.direction, files }, onActivity: message => activity(id, message) });
      });
      if (!proposal) return;
      const result = await proposal;
      const applied = await serial(async () => {
        if (state.order?.id !== id || state.order.status !== 'RUNNING') {
          if (state.order?.id === id && state.order.status === 'STOPPING') await commit('pause-acknowledged', { order: { ...state.order, status: 'PAUSED' } });
          return false;
        }
        order = clone(state.order);
        if (result.status !== 'completed') fail(result.status === 'interrupted' ? 'INTERRUPTED' : 'AGENT_FAILED', result.error ?? 'Managed agent did not complete.');
        await verifyOrder(order);
        if ((await capture(candidateDir(order), await tree(candidateDir(order)))).digest !== hash(order.input.files.filter(file => file.sha256 !== null))) fail('WORKER_WRITE', 'Worker directly changed its read-only input candidate.');
        if (!Array.isArray(result.edits) || !result.edits.length || result.edits.length > 64) fail('INVALID_PROPOSAL', 'Expected 1–64 bounded edits.');
        const seen = new Set(); let total = 0;
        for (const edit of result.edits) {
          if (Object.keys(edit).some(key => !['path', 'content'].includes(key))) fail('INVALID_PROPOSAL', 'Unexpected edit field.');
          relativePath(edit.path);
          if (seen.has(edit.path.toLowerCase()) || !order.allowedPaths.includes(edit.path) || authorityPath(edit.path)) fail('OUT_OF_SCOPE', 'Proposal contains a duplicate or unauthorized path.');
          seen.add(edit.path.toLowerCase());
          if (edit.content !== null && typeof edit.content !== 'string') fail('INVALID_PROPOSAL', 'File content must be text or null for deletion.');
          total += Buffer.byteLength(edit.content ?? '');
          if (total > limit) fail('TOO_LARGE', 'Proposal exceeds 1 MiB.');
          await safeFile(candidateDir(order), edit.path, true);
        }
        await commit('proposal-validated', { order: { ...order, status: 'APPLYING', summary: String(result.summary ?? '').slice(0, 4000) } });
        await writeFile(join(orderDir(order), 'proposal.json'), JSON.stringify({ edits: result.edits, summary: result.summary ?? '' }, null, 2), { flag: 'wx' });
        for (const edit of result.edits) {
          const dest = join(candidateDir(order), edit.path);
          if (edit.content === null) { try { await unlink(dest); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
          else { await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, edit.content); }
        }
        const candidate = await capture(candidateDir(order), await tree(candidateDir(order)));
        const sourceCandidate = await capture(candidateDir(order), order.profile.inputPaths, order.allowedPaths);
        await commit('candidate-created', { order: { ...state.order, status: 'CHECKING', candidate, sourceCandidate } });
        return true;
      });
      if (!applied) return;
      for (const check of order.profile.checks) {
        if (state.order.status !== 'CHECKING') break;
        const before = await capture(candidateDir(order), order.profile.inputPaths, order.allowedPaths);
        if (before.digest !== state.order.sourceCandidate.digest) fail('SOURCE_CHANGED', 'Candidate source changed before verification.');
        let pendingCheck;
        await serial(async () => { if (state.order.id === id && state.order.status === 'CHECKING') pendingCheck = runCheck(clone(state.order), check, before); });
        if (!pendingCheck) break;
        const evidence = await pendingCheck;
        await serial(async () => {
          if (state.order.id !== id) return;
          const checks = [...state.order.checks, evidence];
          // A Node process exit does not prove its descendants stopped. Retain
          // uncertainty after a forced stop instead of claiming full quiescence.
          const status = evidence.status === 'UNKNOWN' ? 'UNKNOWN' : state.order.status === 'STOPPING' ? 'PAUSED' : evidence.status !== 'PASSED' ? 'FAILED' : state.order.status;
          await commit('check-observed', { order: { ...state.order, checks, status } });
        });
      }
      await serial(async () => {
        if (state.order.id !== id || state.order.status !== 'CHECKING') return;
        await verifyOrder(state.order);
        const candidate = await capture(candidateDir(order), await tree(candidateDir(order)));
        await commit('candidate-ready-for-review', { order: { ...state.order, candidate, status: 'REVIEW' } });
      });
    } catch (error) {
      await serial(async () => {
        if (state.order?.id !== id) return;
        const status = state.order.status === 'STOPPING' && error.code === 'INTERRUPTED' ? 'PAUSED' : error.code === 'CONNECTION_LOST' ? 'UNKNOWN' : 'FAILED';
        await commit('execution-stopped', { order: { ...state.order, status, error: `${error.code ?? 'ERROR'}: ${error.message}` } });
      });
    } finally {
      await serial(async () => {
        if (state.order?.id === id && state.order.status === 'STOPPING')
          await commit('pause-acknowledged', { order: { ...state.order, status: 'PAUSED' } });
      });
    }
  }
  async function action(request) {
    return serial(async () => {
      const fields = ['action', 'projectId', 'rootIdentity', 'expectedRevision', 'bindingDigest', 'orderId', 'confirm', 'candidateDigest', 'text'];
      if (!request || Object.keys(request).some(key => !fields.includes(key))) fail('INVALID_ACTION', 'Unsupported decision field.');
      await checkRequest(request);
      if (request.action === 'prepare') await prepare();
      else if (request.action === 'start') {
        if (!adapter || state.order.status !== 'PREPARED') fail('NOT_READY', 'A prepared order and local adapter are required.');
        await verifyOrder(state.order); await commit('execution-started', { order: { ...state.order, status: 'RUNNING' } });
        worker = execute(state.order.id); worker.catch(() => {});
      } else if (request.action === 'pause' || request.action === 'steer') {
        const direction = request.action === 'steer' ? String(request.text ?? '').trim() : state.direction;
        if (request.action === 'steer' && (!direction || direction.length > 4000)) fail('INVALID_DIRECTION', 'Supply a bounded direction change.');
        if (!active.has(state.order.status) && state.order.status !== 'PREPARED') fail('NOT_RUNNING', 'No managed work can be interrupted.');
        const status = state.order.status === 'PREPARED' ? 'PAUSED' : 'STOPPING';
        await commit(request.action === 'steer' ? 'human-replan-requested' : 'human-pause-requested', { direction, order: { ...state.order, status } });
        if (checkChild) { checkChild.brainInterrupted = true; checkChild.kill(); }
        if (status === 'STOPPING') Promise.resolve(adapter?.interrupt()).catch(error => activity(state.order.id, { type: 'interrupt-error', text: error.message }));
      } else if (request.action === 'accept') {
        const order = state.order;
        if (order.status !== 'REVIEW' || !order.checks.length || order.checks.some(check => check.status !== 'PASSED')) fail('NOT_VERIFIED', 'Current candidate lacks passing observed checks.');
        await verifyOrder(order);
        const candidate = await capture(candidateDir(order), await tree(candidateDir(order)));
        if (candidate.digest !== order.candidate.digest || request.candidateDigest !== candidate.digest) fail('STALE_CANDIDATE', 'Candidate changed since the displayed evidence.');
        const review = String(request.text ?? '').trim();
        if (!review || review.length > 4000) fail('REVIEW_REQUIRED', 'Record the human review and its limitations.');
        await commit('human-accepted-candidate', { order: { ...order, status: 'ACCEPTED', humanReview: review } });
      } else fail('INVALID_ACTION', 'Unknown fixed controller action.');
      return clone(state);
    });
  }
  async function preview() {
    const order = state.order;
    if (!order?.profile.previewPath || !['REVIEW', 'ACCEPTED'].includes(order.status)) fail('NO_PREVIEW', 'No verified candidate preview is available.');
    if ((await capture(candidateDir(order), await tree(candidateDir(order)))).digest !== order.candidate.digest) fail('STALE_CANDIDATE', 'Preview bytes differ from verified candidate.');
    return safeFile(candidateDir(order), order.profile.previewPath);
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (active.has(state.order?.status)) await serial(() => commit('controller-closing', { order: { ...state.order, status: 'UNKNOWN', error: 'Controller closed; execution must be reconciled before reuse.' } }));
    if (checkChild) { checkChild.brainInterrupted = true; checkChild.kill(); } await adapter?.close?.();
    if (worker) await worker;
    await queue;
    if (await readFile(join(store, 'writer.lock'), 'utf8') === lockToken) await unlink(join(store, 'writer.lock'));
  }
  return { snapshot, action, preview, close, waitForIdle: async () => { await worker; await queue; }, storeRoot: store };
}
