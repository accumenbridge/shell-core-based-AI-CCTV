import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE_REL = '.brain/atlas/project.json';
const ATLAS_DIR_REL = '.brain/atlas';
const SCHEMA = 'brain.atlas.v1';
const NODE_KINDS = ['outcome', 'journey', 'screen', 'component', 'contract', 'milestone', 'story', 'backlog'];
const OBSERVATION_STATES = ['reported', 'implemented', 'verified', 'blocked', 'not_run', 'unknown'];
const MAX_NODES = 2000;
const MAX_REFS = 500;
const MAX_OBSERVATIONS = 2000;
const MAX_RETROSPECTIVES = 500;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, required, at, errors) {
  if (!isObject(value)) {
    errors.push(`${at} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${at}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${at}.${key} is not a supported field`);
  }
  return true;
}

function textField(value, at, errors, { allowEmpty = true, max = 8000 } = {}) {
  if (typeof value !== 'string') {
    errors.push(`${at} must be a string`);
    return;
  }
  if (!allowEmpty && value.trim() === '') errors.push(`${at} must not be empty`);
  if (value.length > max) errors.push(`${at} exceeds ${max} characters`);
}

function idField(value, at, errors) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) errors.push(`${at} must be a stable identifier`);
}

function enumField(value, options, at, errors) {
  if (!options.includes(value)) errors.push(`${at} must be one of: ${options.join(', ')}`);
}

function dateField(value, at, errors) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    errors.push(`${at} must be an ISO datetime with a timezone`);
  }
}

function stringArray(value, at, errors, { max = MAX_REFS, unique = true } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${at} must be an array`);
    return [];
  }
  if (value.length > max) errors.push(`${at} exceeds ${max} entries`);
  const seen = new Set();
  value.forEach((entry, index) => {
    textField(entry, `${at}[${index}]`, errors, { allowEmpty: false, max: 2000 });
    if (typeof entry === 'string') {
      if (unique && seen.has(entry)) errors.push(`${at} contains duplicate value ${entry}`);
      seen.add(entry);
    }
  });
  return value.filter((entry) => typeof entry === 'string');
}

function isSafeRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function visitDependency(nodeId, byId, visiting, visited, ordered, errors) {
  if (visited.has(nodeId)) return;
  if (visiting.has(nodeId)) {
    errors.push(`nodes dependency cycle includes ${nodeId}`);
    return;
  }
  visiting.add(nodeId);
  const node = byId.get(nodeId);
  for (const dep of Array.isArray(node?.dependsOn) ? node.dependsOn : []) {
    if (byId.has(dep)) visitDependency(dep, byId, visiting, visited, ordered, errors);
  }
  visiting.delete(nodeId);
  visited.add(nodeId);
  if (node) ordered.push(node);
}

function dependencyOrder(nodes) {
  const errors = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  for (const node of nodes) visitDependency(node.id, byId, visiting, visited, ordered, errors);
  return { ordered, errors };
}

/** Pure structural validation. It does not read files or authenticate any claims. */
export function validateAtlas(profile) {
  const errors = [];
  exactKeys(profile,
    ['schema', 'projectId', 'title', 'planRevision', 'updatedAt', 'intentBasis', 'vision', 'policy', 'sourceRefs', 'nodes', 'observations', 'retrospectives', 'focusNodeId'],
    ['schema', 'projectId', 'title', 'planRevision', 'updatedAt', 'intentBasis', 'vision', 'policy', 'sourceRefs', 'nodes', 'observations', 'retrospectives'],
    'profile', errors);
  if (!isObject(profile)) return { valid: false, errors };

  if (profile.schema !== SCHEMA) errors.push(`profile.schema must be ${SCHEMA}`);
  idField(profile.projectId, 'profile.projectId', errors);
  textField(profile.title, 'profile.title', errors, { allowEmpty: false, max: 300 });
  if (!Number.isSafeInteger(profile.planRevision) || profile.planRevision < 1) errors.push('profile.planRevision must be a positive integer');
  dateField(profile.updatedAt, 'profile.updatedAt', errors);
  textField(profile.intentBasis, 'profile.intentBasis', errors);
  if (Object.hasOwn(profile, 'focusNodeId') && profile.focusNodeId !== null) idField(profile.focusNodeId, 'profile.focusNodeId', errors);

  if (exactKeys(profile.vision, ['destination', 'users', 'nonGoals', 'successSignals'], ['destination', 'users', 'nonGoals', 'successSignals'], 'profile.vision', errors)) {
    textField(profile.vision.destination, 'profile.vision.destination', errors);
    stringArray(profile.vision.users, 'profile.vision.users', errors);
    stringArray(profile.vision.nonGoals, 'profile.vision.nonGoals', errors);
    const signals = profile.vision.successSignals;
    if (!Array.isArray(signals)) errors.push('profile.vision.successSignals must be an array');
    else {
      if (signals.length > 200) errors.push('profile.vision.successSignals exceeds 200 entries');
      signals.forEach((signal, index) => {
        const at = `profile.vision.successSignals[${index}]`;
        if (!exactKeys(signal, ['label', 'definition', 'baseline', 'target'], ['label', 'definition', 'baseline', 'target'], at, errors)) return;
        textField(signal.label, `${at}.label`, errors, { allowEmpty: false, max: 300 });
        textField(signal.definition, `${at}.definition`, errors);
        for (const field of ['baseline', 'target']) {
          if (signal[field] !== null) textField(signal[field], `${at}.${field}`, errors);
        }
      });
    }
  }

  if (exactKeys(profile.policy, ['coreFirst', 'workInProgressLimit', 'reviewCadence', 'nonNegotiables', 'deferRule'], ['coreFirst', 'workInProgressLimit', 'reviewCadence', 'nonNegotiables', 'deferRule'], 'profile.policy', errors)) {
    textField(profile.policy.coreFirst, 'profile.policy.coreFirst', errors);
    if (profile.policy.workInProgressLimit !== 1) errors.push('profile.policy.workInProgressLimit must be 1');
    stringArray(profile.policy.reviewCadence, 'profile.policy.reviewCadence', errors);
    stringArray(profile.policy.nonNegotiables, 'profile.policy.nonNegotiables', errors);
    textField(profile.policy.deferRule, 'profile.policy.deferRule', errors);
  }

  const sourceIds = new Set();
  if (!Array.isArray(profile.sourceRefs)) errors.push('profile.sourceRefs must be an array');
  else {
    if (profile.sourceRefs.length > MAX_REFS) errors.push(`profile.sourceRefs exceeds ${MAX_REFS} entries`);
    profile.sourceRefs.forEach((ref, index) => {
      const at = `profile.sourceRefs[${index}]`;
      if (!exactKeys(ref, ['id', 'path', 'role', 'sha256'], ['id', 'path', 'role'], at, errors)) return;
      idField(ref.id, `${at}.id`, errors);
      if (sourceIds.has(ref.id)) errors.push(`${at}.id duplicates ${ref.id}`);
      sourceIds.add(ref.id);
      textField(ref.path, `${at}.path`, errors, { allowEmpty: false, max: 1000 });
      if (typeof ref.path === 'string' && !isSafeRepoPath(ref.path)) errors.push(`${at}.path must be a confined repository-relative path using forward slashes`);
      textField(ref.role, `${at}.role`, errors, { allowEmpty: false, max: 1000 });
      if (Object.hasOwn(ref, 'sha256') && (typeof ref.sha256 !== 'string' || !SHA_PATTERN.test(ref.sha256))) errors.push(`${at}.sha256 must be a 64-character SHA-256 digest`);
    });
  }

  const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
  if (!Array.isArray(profile.nodes)) errors.push('profile.nodes must be an array');
  if (nodes.length > MAX_NODES) errors.push(`profile.nodes exceeds ${MAX_NODES} entries`);
  const nodeIds = new Set();
  nodes.forEach((node, index) => {
    const at = `profile.nodes[${index}]`;
    if (!exactKeys(node, ['id', 'kind', 'title', 'summary', 'owner', 'intentStatus', 'priority', 'priorityReason', 'dependsOn', 'links', 'sourceRefs', 'acceptance'], ['id', 'kind', 'title', 'summary', 'owner', 'intentStatus', 'priority', 'priorityReason', 'dependsOn', 'links', 'sourceRefs', 'acceptance'], at, errors)) return;
    idField(node.id, `${at}.id`, errors);
    if (nodeIds.has(node.id)) errors.push(`${at}.id duplicates ${node.id}`);
    nodeIds.add(node.id);
    enumField(node.kind, NODE_KINDS, `${at}.kind`, errors);
    textField(node.title, `${at}.title`, errors, { allowEmpty: false, max: 500 });
    textField(node.summary, `${at}.summary`, errors);
    textField(node.owner, `${at}.owner`, errors, { allowEmpty: false, max: 500 });
    enumField(node.intentStatus, ['accepted', 'proposed'], `${at}.intentStatus`, errors);
    enumField(node.priority, ['core', 'supporting', 'later'], `${at}.priority`, errors);
    textField(node.priorityReason, `${at}.priorityReason`, errors);
    stringArray(node.dependsOn, `${at}.dependsOn`, errors);
    stringArray(node.links, `${at}.links`, errors);
    const refs = stringArray(node.sourceRefs, `${at}.sourceRefs`, errors);
    for (const ref of refs) if (!sourceIds.has(ref)) errors.push(`${at}.sourceRefs references unknown source ${ref}`);
    stringArray(node.acceptance, `${at}.acceptance`, errors);
  });

  for (const [index, node] of nodes.entries()) {
    if (!isObject(node) || typeof node.id !== 'string') continue;
    for (const relation of ['dependsOn', 'links']) {
      if (!Array.isArray(node[relation])) continue;
      for (const target of node[relation]) {
        if (!nodeIds.has(target)) errors.push(`profile.nodes[${index}].${relation} references unknown node ${target}`);
        if (target === node.id) errors.push(`profile.nodes[${index}].${relation} cannot reference itself`);
      }
    }
  }
  if (typeof profile.focusNodeId === 'string' && !nodeIds.has(profile.focusNodeId)) errors.push(`profile.focusNodeId references unknown node ${profile.focusNodeId}`);
  if (nodes.length > 0) errors.push(...dependencyOrder(nodes.filter((n) => isObject(n) && typeof n.id === 'string')).errors);

  const observationIds = new Set();
  if (!Array.isArray(profile.observations)) errors.push('profile.observations must be an array');
  else {
    if (profile.observations.length > MAX_OBSERVATIONS) errors.push(`profile.observations exceeds ${MAX_OBSERVATIONS} entries`);
    profile.observations.forEach((observation, index) => {
      const at = `profile.observations[${index}]`;
      if (!exactKeys(observation, ['id', 'nodeId', 'state', 'summary', 'sourceRefs', 'candidate', 'observedAt', 'provenance', 'limitations'], ['id', 'nodeId', 'state', 'summary', 'sourceRefs', 'candidate', 'observedAt', 'provenance', 'limitations'], at, errors)) return;
      idField(observation.id, `${at}.id`, errors);
      if (observationIds.has(observation.id)) errors.push(`${at}.id duplicates ${observation.id}`);
      if (sourceIds.has(observation.id)) errors.push(`${at}.id collides with source reference ${observation.id}`);
      observationIds.add(observation.id);
      idField(observation.nodeId, `${at}.nodeId`, errors);
      if (!nodeIds.has(observation.nodeId)) errors.push(`${at}.nodeId references unknown node ${observation.nodeId}`);
      enumField(observation.state, OBSERVATION_STATES, `${at}.state`, errors);
      textField(observation.summary, `${at}.summary`, errors);
      const refs = stringArray(observation.sourceRefs, `${at}.sourceRefs`, errors);
      for (const ref of refs) if (!sourceIds.has(ref)) errors.push(`${at}.sourceRefs references unknown source ${ref}`);
      if (observation.candidate !== null) textField(observation.candidate, `${at}.candidate`, errors, { allowEmpty: false, max: 1000 });
      dateField(observation.observedAt, `${at}.observedAt`, errors);
      enumField(observation.provenance, ['reported-history', 'source-inspection', 'execution-record'], `${at}.provenance`, errors);
      stringArray(observation.limitations, `${at}.limitations`, errors);
      if (observation.state === 'verified') {
        if (typeof observation.candidate !== 'string' || observation.candidate.trim() === '') errors.push(`${at} verified observations require a candidate`);
        if (!Array.isArray(observation.sourceRefs) || observation.sourceRefs.length === 0) errors.push(`${at} verified observations require source references`);
        if (observation.provenance !== 'execution-record') errors.push(`${at} verified observations require execution-record provenance`);
      }
    });
  }

  if (!Array.isArray(profile.retrospectives)) errors.push('profile.retrospectives must be an array');
  else {
    if (profile.retrospectives.length > MAX_RETROSPECTIVES) errors.push(`profile.retrospectives exceeds ${MAX_RETROSPECTIVES} entries`);
    const retrospectiveIds = new Set();
    const evidenceIds = new Set([...sourceIds, ...observationIds]);
    profile.retrospectives.forEach((retro, index) => {
      const at = `profile.retrospectives[${index}]`;
      if (!exactKeys(retro, ['id', 'problem', 'evidenceRefs', 'hypothesis', 'action', 'owner', 'measure', 'status'], ['id', 'problem', 'evidenceRefs', 'hypothesis', 'action', 'owner', 'measure', 'status'], at, errors)) return;
      idField(retro.id, `${at}.id`, errors);
      if (retrospectiveIds.has(retro.id)) errors.push(`${at}.id duplicates ${retro.id}`);
      retrospectiveIds.add(retro.id);
      textField(retro.problem, `${at}.problem`, errors, { allowEmpty: false });
      const refs = stringArray(retro.evidenceRefs, `${at}.evidenceRefs`, errors);
      for (const ref of refs) if (!evidenceIds.has(ref)) errors.push(`${at}.evidenceRefs references unknown source or observation ${ref}`);
      textField(retro.hypothesis, `${at}.hypothesis`, errors);
      textField(retro.action, `${at}.action`, errors);
      textField(retro.owner, `${at}.owner`, errors, { allowEmpty: false, max: 500 });
      textField(retro.measure, `${at}.measure`, errors);
      enumField(retro.status, ['proposed', 'in_progress', 'measured'], `${at}.status`, errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digestProfile(profile) {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex');
}

function digestInspection(projectId, profileDigest, inspectedAt, errors, sourceChecks) {
  return createHash('sha256').update(canonicalJson({
    schema: 'brain.atlas.inspection.v1',
    projectId,
    profileDigest,
    inspectedAt,
    errors,
    sourceChecks,
  })).digest('hex');
}

function isDateTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function inspectBinding(profile, inspection) {
  const profileDigest = digestProfile(profile);
  if (inspection === undefined || inspection === null) {
    return { projectId: profile.projectId, profileDigest, inspectedAt: null, status: 'NOT_INSPECTED', sourceChecks: [] };
  }
  if (!isObject(inspection)) throw new Error('Inspection binding must be an inspection object');
  if (inspection.projectId !== profile.projectId) throw new Error('Inspection belongs to a different project identity');
  if (inspection.profileDigest !== profileDigest) throw new Error('Inspection profile digest does not match the supplied atlas profile');
  if (!isObject(inspection.profile) || digestProfile(inspection.profile) !== profileDigest) throw new Error('Inspection profile snapshot does not match the supplied atlas profile');
  if (!isDateTime(inspection.inspectedAt)) throw new Error('Inspection binding has no valid inspectedAt timestamp');
  if (!Array.isArray(inspection.sourceChecks)) throw new Error('Inspection binding sourceChecks must be an array');
  if (!Array.isArray(inspection.errors) || inspection.errors.some((error) => typeof error !== 'string')) throw new Error('Inspection binding errors must be a string array');

  const refs = new Map(profile.sourceRefs.map((source) => [source.id, source]));
  const seen = new Set();
  for (const check of inspection.sourceChecks) {
    if (!isObject(check) || typeof check.id !== 'string') throw new Error('Inspection contains a malformed source check');
    if (seen.has(check.id)) throw new Error(`Inspection contains duplicate source check ${check.id}`);
    seen.add(check.id);
    const source = refs.get(check.id);
    if (!source) throw new Error(`Inspection contains an extra source check ${check.id}`);
    if (check.path !== source.path) throw new Error(`Inspection path for ${check.id} does not match the profile`);
    if (!Object.hasOwn(check, 'expectedSha256') || check.expectedSha256 !== (source.sha256 ?? null)) {
      throw new Error(`Inspection expected digest for ${check.id} does not match the profile`);
    }
    if (!['MATCHED', 'DRIFT', 'MISSING', 'UNPINNED', 'UNSAFE'].includes(check.state)) throw new Error(`Inspection source check ${check.id} has an unknown state`);
    if (check.currentSha256 !== null && (typeof check.currentSha256 !== 'string' || !SHA_PATTERN.test(check.currentSha256))) {
      throw new Error(`Inspection current digest for ${check.id} is malformed`);
    }
    if (check.state === 'MATCHED' && (!source.sha256 || typeof check.currentSha256 !== 'string' || check.currentSha256.toLowerCase() !== source.sha256.toLowerCase())) {
      throw new Error(`Inspection MATCHED state for ${check.id} is inconsistent with its digests`);
    }
    if (check.state === 'DRIFT' && (!source.sha256 || typeof check.currentSha256 !== 'string' || check.currentSha256.toLowerCase() === source.sha256.toLowerCase())) {
      throw new Error(`Inspection DRIFT state for ${check.id} is inconsistent with its digests`);
    }
    if (check.state === 'UNPINNED' && (source.sha256 || typeof check.currentSha256 !== 'string')) {
      throw new Error(`Inspection UNPINNED state for ${check.id} is inconsistent with its digests`);
    }
    if (['MISSING', 'UNSAFE'].includes(check.state) && check.currentSha256 !== null) {
      throw new Error(`Inspection ${check.state} state for ${check.id} cannot have a current digest`);
    }
  }
  for (const source of profile.sourceRefs) if (!seen.has(source.id)) throw new Error(`Inspection is missing source check ${source.id}`);

  const expectedInspectionDigest = digestInspection(inspection.projectId, inspection.profileDigest, inspection.inspectedAt, inspection.errors, inspection.sourceChecks);
  if (inspection.inspectionDigest !== expectedInspectionDigest) throw new Error('Inspection digest does not bind this profile snapshot, source checks and inspection time');

  const hasUnsafe = inspection.sourceChecks.some((check) => check.state === 'UNSAFE');
  const hasWarnings = inspection.sourceChecks.some((check) => check.state !== 'MATCHED');
  const hasInspectionErrors = Array.isArray(inspection.errors) && inspection.errors.length > 0;
  const status = hasUnsafe || hasInspectionErrors ? 'INVALID' : hasWarnings ? 'DEGRADED' : 'VALID';
  return {
    projectId: profile.projectId,
    profileDigest,
    inspectionDigest: expectedInspectionDigest,
    inspectedAt: inspection.inspectedAt,
    status,
    sourceChecks: inspection.sourceChecks,
  };
}

function planningGaps(profile) {
  const gaps = [];
  const add = (id, message, nodeId = null) => gaps.push({ id, message, nodeId });
  if (!profile.intentBasis.trim()) add('intent-basis', 'Project intent basis has not been recorded.');
  if (!profile.vision.destination.trim()) add('vision-destination', 'Project vision or destination is empty.');
  if (profile.vision.users.length === 0) add('vision-users', 'Intended users have not been identified.');
  if (profile.vision.successSignals.length === 0) add('vision-success-signals', 'No success signals are defined.');

  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const acceptanceKinds = new Set(['journey', 'screen', 'milestone', 'story']);
  for (const node of profile.nodes) {
    if (acceptanceKinds.has(node.kind) && node.acceptance.length === 0) {
      add(`acceptance-${node.id}`, `${node.title} (${node.id}): ${node.kind} has no acceptance statements.`, node.id);
    }
    if (node.kind === 'screen' && node.intentStatus === 'proposed') {
      add(`screen-design-${node.id}`, `${node.title} (${node.id}): screen design is proposed and needs review.`, node.id);
    }
    if (node.kind === 'milestone') {
      const linkedStory = profile.nodes.some((candidate) => candidate.kind === 'story'
        && candidate.links.includes(node.id))
        || node.links.some((id) => byId.get(id)?.kind === 'story');
      if (!linkedStory) add(`milestone-story-${node.id}`, `${node.title} (${node.id}): milestone has no linked story.`, node.id);
    }
  }
  return gaps;
}

function nodeAnchor(id) { return `node-${id}`; }
function sourceAnchor(id) { return `source-${id}`; }

function relationLinks(ids, byId, label) {
  if (!ids?.length) return '';
  return `<p class="relations"><strong>${escapeHtml(label)}:</strong> ${ids.map((id) => {
    const target = byId.get(id);
    return `<a href="#${nodeAnchor(id)}">${escapeHtml(target?.title ?? id)}</a>`;
  }).join(' · ')}</p>`;
}

function renderSourceRefs(ids, sourceById) {
  if (!ids?.length) return '<span class="muted">No source references</span>';
  return ids.map((id) => `<a href="#${sourceAnchor(id)}">${escapeHtml(sourceById.get(id)?.id ?? id)}</a>`).join(' · ');
}

function renderEvidenceRefs(ids, sourceById, observationIds = new Set()) {
  if (!ids?.length) return '<span class="muted">No evidence references</span>';
  return ids.map((id) => {
    if (sourceById.has(id)) return `<a href="#${sourceAnchor(id)}">${escapeHtml(id)}</a>`;
    if (observationIds.has(id)) return `<a href="#observation-${escapeHtml(id)}">${escapeHtml(id)}</a>`;
    return escapeHtml(id);
  }).join(' · ');
}

function renderObservation(observation, sourceById = new Map(), byId = new Map(), canonicalAnchor = true) {
  const caveat = observation.state === 'verified' ? 'Attributed verified claim; this tool cannot authenticate it.' : `Provenance: ${observation.provenance}`;
  const node = byId.get(observation.nodeId);
  return `<article class="observation state-${escapeHtml(observation.state)}"${canonicalAnchor ? ` id="observation-${escapeHtml(observation.id)}"` : ''}>
    <div class="observation-head"><strong><a href="#${nodeAnchor(observation.nodeId)}">${escapeHtml(observation.id)} · ${escapeHtml(observation.state.replaceAll('_', ' ').toUpperCase())}${node ? ` · ${escapeHtml(node.title)}` : ''}</a></strong><span>${escapeHtml(observation.observedAt)}</span></div>
    <p>${escapeHtml(observation.summary)}</p>
    <p class="meta">${escapeHtml(caveat)}${observation.candidate ? ` · Candidate: <code>${escapeHtml(observation.candidate)}</code>` : ''}</p>
    <p class="meta">Sources: ${renderSourceRefs(observation.sourceRefs, sourceById)}</p>
    ${observation.limitations.length ? `<p class="limitation"><strong>Limitations:</strong> ${observation.limitations.map(escapeHtml).join(' · ')}</p>` : ''}
  </article>`;
}

function nodeCard(node, byId, sourceById, observations) {
  const noAcceptance = ['journey', 'screen', 'milestone', 'story'].includes(node.kind) && node.acceptance.length === 0;
  return `<article class="node-card priority-${escapeHtml(node.priority)}" id="${nodeAnchor(node.id)}">
    <div class="node-meta"><span>${escapeHtml(node.kind)}</span><span>Intent: ${escapeHtml(node.intentStatus)}</span><span>Priority: ${escapeHtml(node.priority)}</span></div>
    <h3>${escapeHtml(node.title)}</h3><p class="node-id">${escapeHtml(node.id)} · Owner: ${escapeHtml(node.owner)}</p>
    <p>${escapeHtml(node.summary)}</p>
    <p class="priority-reason"><strong>Priority reason:</strong> ${escapeHtml(node.priorityReason)}</p>
    ${noAcceptance ? `<p class="gap"><strong>Acceptance statements are missing.</strong> ${escapeHtml(node.kind)} criteria remain to be planned.</p>` : ''}
    ${node.acceptance.length ? `<div class="acceptance"><strong>Acceptance statements</strong><ul>${node.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
    ${relationLinks(node.dependsOn, byId, 'Depends on')}
    ${relationLinks(node.links, byId, 'Related nodes')}
    <p class="relations"><strong>Source provenance:</strong> ${renderSourceRefs(node.sourceRefs, sourceById)}</p>
    ${observations.length ? `<div class="node-observations"><h4>Separate observations</h4>${observations.map((item) => renderObservation(item, sourceById, byId, false)).join('')}</div>` : '<p class="muted">No delivery observation is recorded; unassessed does not mean complete.</p>'}
  </article>`;
}

const FLOW_STAGES = [
  { title: 'Outcome', kinds: ['outcome'], description: 'User or project destination' },
  { title: 'Journey', kinds: ['journey'], description: 'Steps toward the outcome' },
  { title: 'Screen, contract, component', kinds: ['screen', 'contract', 'component'], description: 'Experience and owner boundaries' },
  { title: 'Story and backlog', kinds: ['story', 'backlog'], description: 'Bounded work and deferred items' },
  { title: 'Milestone and evidence', kinds: ['milestone'], description: 'Ordered delivery with separate observations' },
];

/** Pure offline HTML projection; supplied inspection data is displayed as a snapshot. */
export function renderAtlas(profile, inspection = undefined, executionProjection = undefined) {
  const validation = validateAtlas(profile);
  if (!validation.valid) throw new Error(`Cannot render invalid atlas: ${validation.errors.join('; ')}`);
  const binding = inspectBinding(profile, inspection);
  const sources = binding.sourceChecks;
  const checkById = new Map(sources.map((item) => [item.id, item]));
  const sourceById = new Map(profile.sourceRefs.map((source) => [source.id, source]));
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const gaps = planningGaps(profile);
  const observationsByNode = new Map();
  for (const observation of profile.observations) {
    const list = observationsByNode.get(observation.nodeId) ?? [];
    list.push(observation);
    observationsByNode.set(observation.nodeId, list);
  }
  const planIsEmpty = profile.nodes.length === 0;
  const stagesHtml = FLOW_STAGES.map((stage, index) => {
    const stageNodes = profile.nodes.filter((node) => stage.kinds.includes(node.kind));
    const items = stageNodes.length
      ? stageNodes.map((node) => `<li><a href="#${nodeAnchor(node.id)}"><strong>${escapeHtml(node.title)}</strong><span>${escapeHtml(node.id)} · ${escapeHtml(node.intentStatus)} · ${escapeHtml(node.priority)}</span></a></li>`).join('')
      : '<li class="empty-stage">No item is mapped yet.</li>';
    const evidenceNote = index === 4
      ? `<div class="flow-evidence">${profile.observations.length ? `${profile.observations.length} separate observation${profile.observations.length === 1 ? '' : 's'} below` : 'No observations recorded'}</div>`
      : '';
    return `<section class="flow-stage"><h3>${escapeHtml(stage.title)}</h3><p>${escapeHtml(stage.description)}</p><ul>${items}</ul>${evidenceNote}</section>`;
  }).join('<div class="flow-arrow" aria-hidden="true">→</div>');

  const ordered = dependencyOrder(profile.nodes).ordered;
  const milestones = ordered.filter((node) => node.kind === 'milestone');
  const milestoneHtml = milestones.length
    ? `<ol class="milestone-map">${milestones.map((node, index) => `<li><a href="#${nodeAnchor(node.id)}"><strong>${escapeHtml(node.title)}</strong><span>${escapeHtml(node.id)}</span></a><p>${node.dependsOn.length ? `Declared dependencies: ${node.dependsOn.map((id) => `<a href="#${nodeAnchor(id)}">${escapeHtml(byId.get(id)?.title ?? id)}</a>`).join(' · ')}` : 'No declared dependencies'}</p></li>`).join('')}</ol>`
    : '<p class="empty-state">No milestones are planned.</p>';

  const observations = profile.observations.length
    ? `<div class="observation-list">${profile.observations.map((item) => renderObservation(item, sourceById, byId)).join('')}</div>`
    : '<p class="empty-state">No delivery observations are recorded. Missing evidence remains unassessed.</p>';

  const sourceRows = profile.sourceRefs.length
    ? profile.sourceRefs.map((source) => {
      const check = checkById.get(source.id);
      const state = check?.state ?? 'NOT_INSPECTED';
      const digestLine = source.sha256
        ? `Pinned SHA-256: <code>${escapeHtml(source.sha256)}</code>`
        : '<strong class="warning-text">No digest pinned.</strong>';
      const currentLine = check?.currentSha256
        ? `Current SHA-256: <code>${escapeHtml(check.currentSha256)}</code>`
        : check?.state === 'MISSING' ? '<strong class="warning-text">File is missing.</strong>' : 'Current digest not available.';
      return `<tr id="${sourceAnchor(source.id)}"><th scope="row"><a href="#${sourceAnchor(source.id)}">${escapeHtml(source.id)}</a></th><td><code>${escapeHtml(source.path)}</code><br>${escapeHtml(source.role)}</td><td><span class="source-state source-${escapeHtml(state.toLowerCase())}">${escapeHtml(state.replaceAll('_', ' '))}</span><br>${digestLine}<br>${currentLine}</td></tr>`;
    }).join('')
    : '<tr><td colspan="3">No source references are listed.</td></tr>';

  const allCards = profile.nodes.map((node) => nodeCard(node, byId, sourceById, observationsByNode.get(node.id) ?? [])).join('');
  const focusNode = profile.focusNodeId ? byId.get(profile.focusNodeId) : null;
  const focusObservations = focusNode ? observationsByNode.get(focusNode.id) ?? [] : [];
  const focusSourceIds = focusNode ? [...new Set([
    ...focusNode.sourceRefs,
    ...focusObservations.flatMap((item) => item.sourceRefs),
  ])] : [];
  const focusGaps = focusNode ? gaps.filter((gap) => gap.nodeId === focusNode.id) : [];
  const focusPanel = focusNode
    ? `<section id="planning-focus" class="panel focus-panel"><h2>Planning focus</h2><p><strong>${escapeHtml(focusNode.title)}</strong> · ${escapeHtml(focusNode.id)}</p><p>${escapeHtml(focusNode.summary)}</p><p><strong>Declared priority reason:</strong> ${escapeHtml(focusNode.priorityReason)}</p>${relationLinks(focusNode.dependsOn, byId, 'Depends on')}<p><strong>Canonical execution checkpoint still selects current work.</strong> This profile focus does not dispatch work or imply acceptance.</p><h3>Focus observations and gaps</h3>${focusObservations.length ? `<ul>${focusObservations.map((item) => `<li><a href="#observation-${escapeHtml(item.id)}">${escapeHtml(item.id)} · ${escapeHtml(item.state.replaceAll('_', ' '))}</a> — ${escapeHtml(item.summary)}</li>`).join('')}</ul>` : '<p class="empty-state">No observations are recorded for this focus.</p>'}${focusGaps.length ? `<ul class="gap-list">${focusGaps.map((gap) => `<li class="gap"><a href="#node-${escapeHtml(gap.nodeId)}">${escapeHtml(gap.message)}</a></li>`).join('')}</ul>` : '<p>No focus-specific gap was found by the current limited checks.</p>'}<h3>Focus source inspection</h3>${focusSourceIds.length ? `<ul>${focusSourceIds.map((id) => { const check = checkById.get(id); const state = check?.state ?? 'NOT_INSPECTED'; return `<li><a href="#${sourceAnchor(id)}">${escapeHtml(sourceById.get(id)?.path ?? id)}</a> · <strong>${escapeHtml(state)}</strong>${state === 'DRIFT' ? ` · Pinned <code>${escapeHtml(check.expectedSha256)}</code>, current <code>${escapeHtml(check.currentSha256)}</code>` : ''}</li>`; }).join('')}</ul>` : '<p>No source references are associated with this focus or its observations.</p>'}</section>`
    : '<section id="planning-focus" class="panel"><h2>Planning focus</h2><p>No planning focus is recorded. The canonical execution checkpoint remains the source for current work selection.</p></section>';
  const currentProjection = executionProjection
    ? `<section id="canonical-current-work" class="panel"><h2>Canonical current work</h2><p><strong>${escapeHtml(executionProjection.taskId ?? 'Unavailable')}</strong>${executionProjection.taskTitle ? ` · ${escapeHtml(executionProjection.taskTitle)}` : ''} · ${escapeHtml(executionProjection.taskStatus ?? 'UNKNOWN')}</p><p>Atlas planning focus: <strong>${escapeHtml(executionProjection.focusNodeId ?? 'not selected')}</strong>${executionProjection.focusTitle ? ` · ${escapeHtml(executionProjection.focusTitle)}` : ''} · <strong>${escapeHtml(executionProjection.alignment ?? 'UNKNOWN')}</strong></p><p>The task comes from the project’s canonical execution contract and checkpoint. The focus comes from this plan; their alignment is inspected separately.</p></section>`
    : '<section id="canonical-current-work" class="panel"><h2>Canonical current work</h2><p>Current execution data was not supplied to this static atlas render. The planning focus is not an execution checkpoint.</p></section>';
  const planningGapPanel = gaps.length
    ? `<section id="planning-gaps" class="panel planning-gaps"><h2>Planning gaps (${gaps.length})</h2><p>These are visible planning gaps, not a structural validation failure or an automatic readiness gate.</p><ul class="gap-list">${gaps.map((gap) => `<li class="gap">${gap.nodeId ? `<a href="#node-${escapeHtml(gap.nodeId)}">${escapeHtml(gap.message)}</a>` : escapeHtml(gap.message)}</li>`).join('')}</ul></section>`
    : '<section id="planning-gaps" class="panel"><h2>Planning gaps</h2><p>No gaps were detected by the limited checks in this renderer; this is not a readiness or completion claim.</p></section>';
  const retrospectives = profile.retrospectives.length
    ? `<div class="retro-grid">${profile.retrospectives.map((retro) => `<article class="retro"><p class="node-meta">${escapeHtml(retro.status)}</p><h3>${escapeHtml(retro.problem)}</h3><p><strong>Evidence:</strong> ${renderEvidenceRefs(retro.evidenceRefs, sourceById, new Set(profile.observations.map((item) => item.id)))}</p><p><strong>Hypothesis:</strong> ${escapeHtml(retro.hypothesis)}</p><p><strong>Action:</strong> ${escapeHtml(retro.action)}</p><p><strong>Owner:</strong> ${escapeHtml(retro.owner)}</p><p><strong>Measure:</strong> ${retro.measure.trim() ? escapeHtml(retro.measure) : '<strong class="gap">No future measure recorded; improvement remains unmeasured.</strong>'}</p></article>`).join('')}</div>`
    : '<p class="empty-state">No retrospectives are recorded.</p>';

  const warningCount = sources.filter((item) => item.state !== 'MATCHED').length;
  const snapshotStatus = binding.status;
  const identityMarker = `<!-- brain-atlas-generated:v1 projectId=${profile.projectId} profileSha256=${binding.profileDigest} -->`;
  const sourceStatusText = snapshotStatus === 'NOT_INSPECTED'
    ? 'Source files have not been inspected; no source validity is inferred.'
    : warningCount
      ? `${warningCount} source reference${warningCount === 1 ? '' : 's'} need attention.`
      : 'Inspected source digests match their pins.';
  return `${identityMarker}
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(profile.title)} — project atlas</title>
<style>
:root{color-scheme:light;--ink:#182334;--muted:#516274;--line:#d3dce6;--paper:#f3f6f9;--card:#fff;--blue:#145a86;--amber:#8b4a00;--red:#a32626}*{box-sizing:border-box}body{margin:0;max-width:100%;overflow-x:hidden;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}a{color:#075c91;text-underline-offset:.15em;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #ef9f25;outline-offset:3px}.wrap{max-width:1440px;width:100%;min-width:0;margin:auto;padding:clamp(1rem,3vw,2.5rem)}header.hero{background:#142d43;color:white;padding:2rem;border-radius:1rem}header.hero a{color:#bde4ff}.eyebrow,.node-meta,.meta,.node-id{color:var(--muted);font-size:.9rem}header.hero .eyebrow,header.hero .node-meta{color:#cee0ee}.hero h1{line-height:1.1;margin:.3rem 0 1rem}.banner,.panel,.node-card,.retro{max-width:100%;min-width:0;overflow-wrap:anywhere;background:var(--card);border:1px solid var(--line);border-radius:.8rem;padding:1.2rem;margin:1rem 0}.banner{border-left:6px solid var(--amber)}.unplanned{border-left-color:var(--blue)}.warning-text,.gap{color:var(--red)}.gap{background:#fff0ef;padding:.7rem;border-radius:.4rem}.section-nav{display:flex;gap:.5rem 1rem;flex-wrap:wrap;padding:1rem 0}.panel h2{margin-top:0}.flow{display:grid;width:100%;min-width:0;max-width:100%;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1.4fr) auto minmax(0,1.2fr) auto minmax(0,1.2fr);align-items:stretch;gap:.5rem;overflow-x:auto;padding:.4rem 0 1rem}.flow-stage{min-width:190px;background:#f7fafc;border:1px solid var(--line);border-radius:.75rem;padding:.9rem}.flow-stage h3{margin:.1rem 0}.flow-stage>p{font-size:.9rem;color:var(--muted)}.flow-stage ul{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}.flow-stage li a{display:block;background:white;border:1px solid var(--line);border-radius:.5rem;padding:.6rem;text-decoration:none}.flow-stage li a span{display:block;font-size:.82rem;color:var(--muted)}.flow-arrow{align-self:center;font-size:1.7rem;font-weight:700;color:var(--blue)}.flow-evidence,.empty-stage{font-size:.85rem;color:var(--muted);padding:.5rem}.milestone-map{counter-reset:milestone;list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:.7rem}.milestone-map li{counter-increment:milestone;position:relative;border:1px solid var(--line);border-radius:.65rem;padding:.8rem .8rem .8rem 2.8rem;background:#f7fafc}.milestone-map li::before{content:counter(milestone);position:absolute;left:.8rem;top:.75rem;width:1.5rem;height:1.5rem;border-radius:50%;display:grid;place-items:center;background:#145a86;color:white;font-weight:700}.milestone-map a{display:inline-block}.milestone-map span{display:block;color:var(--muted);font-size:.85rem}.milestone-map p{margin:.35rem 0 0;font-size:.9rem}.node-grid,.retro-grid{display:grid;min-width:0;grid-template-columns:repeat(auto-fit,minmax(min(100%,350px),1fr));gap:.7rem}.node-card{margin:.35rem 0;scroll-margin-top:1rem}.node-card h3{margin:.25rem 0}.node-meta{display:flex;gap:.4rem .8rem;flex-wrap:wrap}.priority-core{border-top:4px solid #126b48}.priority-supporting{border-top:4px solid #52718a}.priority-later{border-top:4px solid #957443}.priority-reason,.acceptance{background:#f3f7fa;padding:.65rem;border-radius:.4rem}.acceptance ul{margin:.4rem 0}.relations{font-size:.92rem}.node-observations{border-top:1px solid var(--line);margin-top:1rem;padding-top:.5rem}.node-observations h4{margin:.25rem 0}.observation{padding:.7rem;margin:.55rem 0;border-left:4px solid #748698;background:#f6f8fa;border-radius:.35rem}.state-blocked,.state-not_run,.state-unknown{border-left-color:var(--red);background:#fff1f0}.state-reported{border-left-color:#8b5d00}.state-implemented{border-left-color:#24628d}.state-verified{border-left-color:#176345}.observation-head{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}.observation p{margin:.35rem 0}.limitation{color:#7b2d15}.source-table-wrap{max-width:100%;overflow-x:auto}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:.7rem}th{width:12rem}.source-state{display:inline-block;padding:.12rem .45rem;border-radius:1rem;background:#e4edf4;font-weight:700;font-size:.8rem}.source-drift,.source-missing,.source-unsafe{color:var(--red);background:#ffebe9}.source-unpinned,.source-not_inspected{color:var(--amber);background:#fff0d8}.empty-state{padding:1rem;background:#f7fafc;border:1px dashed #9aabba;border-radius:.6rem}.muted{color:var(--muted)}code{overflow-wrap:anywhere;font-size:.88em}footer{border-top:1px solid var(--line);padding:1rem;color:var(--muted)}@media(max-width:900px){.flow{grid-template-columns:1fr;overflow:visible}.flow-arrow{transform:rotate(90deg);justify-self:center}.flow-stage{min-width:0}.hero{padding:1.25rem!important}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><main class="wrap">
<header class="hero"><p class="eyebrow">Read-only offline planning snapshot · Plan revision ${profile.planRevision}</p><h1>${escapeHtml(profile.title)}</h1><p>Project ID: <code>${escapeHtml(profile.projectId)}</code> · Profile updated: ${escapeHtml(profile.updatedAt)}</p><p>Profile SHA-256: <code>${binding.profileDigest}</code></p><p>Source inspection time: ${binding.inspectedAt ? escapeHtml(binding.inspectedAt) : 'NOT_INSPECTED'}</p><p>${escapeHtml(profile.intentBasis || 'Intent basis has not been recorded.')}</p><nav class="section-nav" aria-label="Atlas sections"><a href="#planning-gaps">Planning gaps</a><a href="#planning-focus">Planning focus</a><a href="#vision">Vision</a><a href="#map">Linked project map</a><a href="#milestones">Milestone order</a><a href="#nodes">Node details</a><a href="#observations">Observations</a><a href="#sources">Source provenance</a><a href="#retrospectives">Retrospectives</a></nav></header>
${planIsEmpty ? '<section class="banner unplanned" role="status"><strong>This profile is visibly unplanned.</strong> No nodes, priorities or delivery observations have been added.</section>' : ''}
<section class="banner" role="note"><strong>Structural profile status: ${validation.valid ? 'VALID' : 'INVALID'} · Source inspection: ${escapeHtml(snapshotStatus)} · Planning gaps: ${gaps.length}.</strong> ${escapeHtml(sourceStatusText)} This map does not execute acceptance, authenticate reports or establish product completion.</section>
${currentProjection}${planningGapPanel}${focusPanel}
<section id="vision" class="panel"><h2>Destination and policy</h2><p><strong>Destination:</strong> ${escapeHtml(profile.vision.destination || 'Not stated yet.')}</p><div class="node-grid"><div><h3>Users</h3>${profile.vision.users.length ? `<ul>${profile.vision.users.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="empty-state">No users recorded.</p>'}</div><div><h3>Non-goals</h3>${profile.vision.nonGoals.length ? `<ul>${profile.vision.nonGoals.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="empty-state">No non-goals recorded.</p>'}</div></div><h3>Success signals</h3>${profile.vision.successSignals.length ? `<ul>${profile.vision.successSignals.map((signal) => `<li><strong>${escapeHtml(signal.label)}:</strong> ${escapeHtml(signal.definition)} <span class="muted">Baseline: ${escapeHtml(signal.baseline ?? 'unknown')} · Target: ${escapeHtml(signal.target ?? 'unknown')}</span></li>`).join('')}</ul>` : '<p class="empty-state">No success signals recorded.</p>'}<h3>Working policy</h3><p><strong>Core first:</strong> ${escapeHtml(profile.policy.coreFirst || 'Not stated yet.')} · <strong>WIP limit:</strong> ${profile.policy.workInProgressLimit}</p><p><strong>Review cadence:</strong> ${escapeHtml(profile.policy.reviewCadence.join(' · ') || 'Not stated yet.')}</p><p><strong>Non-negotiables:</strong> ${escapeHtml(profile.policy.nonNegotiables.join(' · ') || 'Not stated yet.')}</p><p><strong>Defer rule:</strong> ${escapeHtml(profile.policy.deferRule || 'Not stated yet.')}</p></section>
<section id="map" class="panel"><h2>Linked project flow</h2><p>Follow declared outcome, journey, experience and owner boundaries, stories, milestones and separate observations. Cards link to their full details below; relationships are listed on each card.</p><div class="flow" aria-label="Outcome to evidence flow">${stagesHtml}</div></section>
<section id="milestones" class="panel"><h2>Milestone dependency order</h2><p>Order is calculated from declared <code>dependsOn</code> edges only. It is a planning aid, not a schedule, progress measure or completion claim.</p>${milestoneHtml}</section>
<section id="nodes" class="panel"><h2>Plan nodes</h2><p>Priority tags and reasons describe declared plan intent; this page does not select current work. Use the existing workflow checkpoint for current task selection. Intent status and observed delivery evidence are separate. “Accepted” describes the plan intent only.</p>${profile.nodes.length ? `<div class="node-grid">${allCards}</div>` : '<p class="empty-state">No plan nodes exist yet.</p>'}</section>
<section id="observations" class="panel"><h2>Delivery observations and gaps</h2><p>Blocked, not-run and unknown observations remain visible. A “verified” label is an attributed record with execution provenance, not authenticated proof.</p>${observations}</section>
<section id="sources" class="panel"><h2>Source provenance and drift</h2><p>Each path is read inside the selected project root. Expected and current SHA-256 values are shown when available. Missing or unpinned digests and changed files are warnings to reconcile; they do not set delivery status.</p><div class="source-table-wrap"><table><thead><tr><th scope="col">Reference</th><th scope="col">Repository source</th><th scope="col">Inspection</th></tr></thead><tbody>${sourceRows}</tbody></table></div></section>
<section id="retrospectives" class="panel"><h2>Retrospectives</h2><p>Hypotheses and proposed measures are kept distinct from observed problems. Empty targets and unknown measurements remain unknown.</p>${retrospectives}</section>
<footer>Generated as a static local snapshot. Re-render after source or profile changes. No scripts, remote assets, execution, or live filesystem access are embedded in this page.</footer>
</main></body></html>`;
}

async function canonicalRoot(rootInput) {
  const root = await realpath(path.resolve(rootInput));
  const stats = await lstat(root);
  if (!stats.isDirectory()) throw new Error(`Selected root is not a directory: ${rootInput}`);
  return root;
}

async function ensureAtlasDirectory(root, { create = false } = {}) {
  const brainDir = path.join(root, '.brain');
  const atlasDir = path.join(brainDir, 'atlas');
  for (const [dir, label] of [[brainDir, '.brain'], [atlasDir, '.brain/atlas']]) {
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory; symlinks and junctions are not allowed`);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(dir);
    }
  }
  const resolved = await realpath(atlasDir);
  const rel = path.relative(root, resolved);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error('Atlas directory resolves outside the selected root');
  return resolved;
}

async function readSafeRepoFile(root, relative) {
  if (!isSafeRepoPath(relative)) throw new Error(`Unsafe repository-relative path: ${relative}`);
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return { missing: true };
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Source path traverses a symlink or junction: ${relative}`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Source parent is not a directory: ${relative}`);
    if (index === parts.length - 1 && !info.isFile()) throw new Error(`Source reference is not a regular file: ${relative}`);
  }
  const resolved = await realpath(current);
  const rel = path.relative(root, resolved);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error(`Source resolves outside the selected root: ${relative}`);
  const bytes = await readFile(current);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Read profile and compare source pins without changing any files. */
export async function inspectAtlas(rootInput) {
  const root = await canonicalRoot(rootInput);
  const atlasDir = await ensureAtlasDirectory(root);
  let profile;
  try {
    const source = await readSafeRepoFile(root, PROFILE_REL);
    if (source.missing) throw new Error('profile file is missing');
    profile = JSON.parse(source.bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Cannot read atlas profile ${PROFILE_REL}: ${error.message}`);
  }
  const validation = validateAtlas(profile);
  const profileDigest = digestProfile(profile);
  const errors = [...validation.errors];
  const sourceChecks = [];
  if (validation.valid) {
    for (const source of profile.sourceRefs) {
      try {
        const result = await readSafeRepoFile(root, source.path);
        if (result.missing) {
          sourceChecks.push({ id: source.id, path: source.path, state: 'MISSING', expectedSha256: source.sha256 ?? null, currentSha256: null });
        } else if (!source.sha256) {
          sourceChecks.push({ id: source.id, path: source.path, state: 'UNPINNED', expectedSha256: null, currentSha256: result.sha256 });
        } else {
          sourceChecks.push({ id: source.id, path: source.path, state: source.sha256.toLowerCase() === result.sha256 ? 'MATCHED' : 'DRIFT', expectedSha256: source.sha256, currentSha256: result.sha256 });
        }
      } catch (error) {
        errors.push(`sourceRefs.${source.id}: ${error.message}`);
        sourceChecks.push({ id: source.id, path: source.path, state: 'UNSAFE', expectedSha256: source.sha256 ?? null, currentSha256: null });
      }
    }
  }
  const warnings = sourceChecks.filter((check) => check.state !== 'MATCHED').map((check) => `${check.id}: ${check.state === 'DRIFT' ? 'pinned digest differs from current file' : check.state === 'MISSING' ? 'source file is missing' : check.state === 'UNPINNED' ? 'no digest is pinned' : 'source path could not be inspected safely'}`);
  const valid = errors.length === 0;
  const sourceStatus = !validation.valid ? 'NOT_RUN' : errors.length ? 'INVALID' : warnings.length ? 'DEGRADED' : 'VALID';
  const status = !valid ? 'INVALID' : sourceStatus;
  const inspectedAt = new Date().toISOString();
  const inspectionDigest = digestInspection(profile?.projectId ?? null, profileDigest, inspectedAt, errors, sourceChecks);
  return {
    root,
    profilePath: PROFILE_REL,
    profile,
    projectId: profile?.projectId ?? null,
    profileDigest,
    inspectionDigest,
    inspectedAt,
    structuralStatus: validation.valid ? 'VALID' : 'INVALID',
    sourceStatus,
    planningGaps: validation.valid ? planningGaps(profile) : [],
    valid,
    status,
    errors,
    warnings,
    sourceChecks,
  };
}

function makeBlankProfile(projectId, title) {
  return {
    schema: SCHEMA,
    projectId,
    title,
    planRevision: 1,
    updatedAt: new Date().toISOString(),
    intentBasis: '',
    vision: { destination: '', users: [], nonGoals: [], successSignals: [] },
    policy: { coreFirst: '', workInProgressLimit: 1, reviewCadence: [], nonNegotiables: [], deferRule: '' },
    sourceRefs: [],
    nodes: [],
    observations: [],
    retrospectives: [],
    focusNodeId: null,
  };
}

async function initializeAtlas(rootInput, projectId, title) {
  if (typeof projectId !== 'string' || !ID_PATTERN.test(projectId)) throw new Error('--project-id must be a stable identifier');
  if (typeof title !== 'string' || title.trim() === '' || title.length > 300) throw new Error('--title must contain 1–300 characters');
  const root = await canonicalRoot(rootInput);
  const atlasDir = await ensureAtlasDirectory(root, { create: true });
  const profilePath = path.join(atlasDir, 'project.json');
  const handle = await open(profilePath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(makeBlankProfile(projectId, title), null, 2)}\n`, 'utf8');
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(profilePath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  return profilePath;
}

function outputRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error('--out must be a repository-relative path under .brain/atlas');
  }
  if (value !== `${ATLAS_DIR_REL}/PROJECT_ATLAS.html`) throw new Error(`--out is fixed at ${ATLAS_DIR_REL}/PROJECT_ATLAS.html`);
  return value;
}

async function writeRenderedAtlas(rootInput, output, profile, inspection, renderedHtml = undefined) {
  const outRel = outputRelativePath(output);
  const root = await canonicalRoot(rootInput);
  const atlasDir = await ensureAtlasDirectory(root);
  const target = path.join(atlasDir, path.basename(outRel));
  const normalizedTarget = path.resolve(target).toLowerCase();
  if (profile.sourceRefs.some((source) => path.resolve(root, ...source.path.split('/')).toLowerCase() === normalizedTarget)) {
    throw new Error('--out cannot overwrite a declared source reference');
  }
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('--out exists and is not a regular file');
    const prior = await readFile(target, 'utf8');
    if (prior.startsWith('<!-- brain-atlas-generated:v1 -->')) {
      throw new Error('Legacy generated atlas has no embedded project identity; archive .brain/atlas/PROJECT_ATLAS.html, then render again.');
    }
    const marker = /^<!-- brain-atlas-generated:v1 projectId=([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) profileSha256=([a-f0-9]{64}) -->/.exec(prior);
    if (!marker) throw new Error('--out exists but is not a generated Brain atlas; refusing to overwrite it');
    if (marker[1] !== profile.projectId) throw new Error(`Generated atlas belongs to project ${marker[1]}, not ${profile.projectId}; archive it before rendering this project.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = path.join(atlasDir, `.atlas-${randomUUID()}.tmp`);
  const html = renderedHtml ?? renderAtlas(profile, inspection);
  try {
    await writeFile(temp, html, { flag: 'wx', encoding: 'utf8' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { target: outRel, bytes: Buffer.byteLength(html, 'utf8') };
}

function parseArgs(args) {
  const command = args[0];
  if (!['init', 'validate', 'render'].includes(command)) throw new Error('Usage: node tools/brain-atlas.mjs <init|validate|render> [options]');
  const options = {};
  const seen = new Set();
  const allowed = new Set(['--root', '--project-id', '--title', '--out']);
  for (let i = 1; i < args.length; i += 1) {
    const key = args[i];
    if (!allowed.has(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`Invalid or missing option value: ${key}`);
    const value = args[++i];
    if (seen.has(key)) throw new Error(`Option supplied more than once: ${key}`);
    seen.add(key);
    options[key.slice(2)] = value;
  }
  options.root ??= process.cwd();
  if (command === 'init' && (!options['project-id'] || !options.title)) throw new Error('init requires --project-id ID and --title TITLE');
  if (command !== 'init' && (options['project-id'] || options.title)) throw new Error('--project-id and --title are only supported by init');
  if (command !== 'render' && options.out) throw new Error('--out is only supported by render');
  return { command, options };
}

function printValidation(result) {
  console.log(`Atlas structure: ${result.structuralStatus}`);
  console.log(`Planning gaps: ${result.planningGaps.length} identified by limited checks; informational, not a readiness gate.`);
  console.log(`Source inspection: ${result.sourceStatus}`);
  if (result.errors.length) for (const error of result.errors) console.log(`ERROR ${error}`);
  if (result.warnings.length) for (const warning of result.warnings) console.log(`WARNING ${warning}`);
  if (!result.errors.length && !result.warnings.length) console.log(`Checked ${result.sourceChecks.length} source reference(s).`);
}

async function main(args) {
  const { command, options } = parseArgs(args);
  if (command === 'init') {
    const profilePath = await initializeAtlas(options.root, options['project-id'], options.title);
    console.log(`Initialized blank atlas at ${path.relative(options.root, profilePath) || PROFILE_REL}. No plan or delivery status was created.`);
    return 0;
  }
  const inspection = await inspectAtlas(options.root);
  if (command === 'validate') {
    printValidation(inspection);
    return inspection.valid ? 0 : 1;
  }
  if (!inspection.valid) {
    printValidation(inspection);
    return 1;
  }
  let executionProjection;
  try {
    const { context } = await import('./brain-core.mjs');
    executionProjection = (await context(options.root)).canonicalProjection;
  } catch (error) {
    executionProjection = { alignment: 'UNAVAILABLE', taskStatus: 'UNKNOWN', error: error.message };
  }
  const output = options.out ?? `${ATLAS_DIR_REL}/PROJECT_ATLAS.html`;
  const html = renderAtlas(inspection.profile, inspection, executionProjection);
  const result = await writeRenderedAtlas(options.root, output, inspection.profile, inspection, html);
  console.log(`Rendered ${result.target} (${result.bytes} bytes) · inspection ${inspection.status} · current task ${executionProjection?.taskId ?? 'unavailable'} · focus alignment ${executionProjection?.alignment ?? 'unavailable'}.`);
  if (inspection.warnings.length) console.log(`Warnings: ${inspection.warnings.length}; see validate output for source details.`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`brain-atlas: ${error.message}`);
    process.exitCode = 1;
  });
}
