const MAX_REASONS = 32;

function normalizedProjectPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.startsWith('/') ||
      /[\x00-\x1f]/.test(value)) return null;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function reason(code, message, details = undefined) {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function sourceIsMatched(source, check) {
  return Boolean(source && check && check.id === source.id && check.path === source.path && check.state === 'MATCHED' &&
    typeof source.sha256 === 'string' && source.sha256 && check.expectedSha256 === source.sha256 &&
    typeof check.currentSha256 === 'string' && check.currentSha256.toLowerCase() === source.sha256.toLowerCase());
}

/**
 * Reduce fresh project inspection into the one readiness view used by normal
 * workflow admission and the managed candidate controller. This is a pure
 * policy function: callers own safe file inspection and evidence provenance.
 */
export function assessReadiness({ atlas = null, task = {}, managedProfile = null } = {}) {
  const reasons = [];
  const advisories = [];
  const add = item => {
    if (reasons.length < MAX_REASONS) reasons.push(item);
  };
  const taskId = typeof task.taskId === 'string' ? task.taskId : null;
  const taskPath = normalizedProjectPath(task.sourceTaskRef);
  const nodes = Array.isArray(atlas?.profile?.nodes) ? atlas.profile.nodes : [];
  const byId = new Map(nodes.filter(node => node && typeof node.id === 'string').map(node => [node.id, node]));
  const focusId = atlas?.profile?.focusNodeId ?? null;
  const focus = typeof focusId === 'string' ? byId.get(focusId) ?? null : null;
  const projection = {
    taskId,
    taskTitle: typeof task.title === 'string' ? task.title : null,
    taskStatus: typeof task.checkpointStatus === 'string' ? task.checkpointStatus : 'NOT_INITIALIZED',
    focusNodeId: focus?.id ?? null,
    focusTitle: typeof focus?.title === 'string' ? focus.title : null,
    alignment: 'NEEDS_RECONCILIATION'
  };

  if (!atlas || atlas.present === false) {
    advisories.push(reason('ATLAS_NOT_CONFIGURED', 'No atlas is configured; legacy workflow behavior remains available without plan governance.'));
    const managedReasons = [reason('MANAGED_ATLAS_REQUIRED', 'Managed work requires an atlas linked to the current canonical task.')];
    if (managedProfile?.status === 'MISSING') managedReasons.push(reason('MANAGED_PROFILE_MISSING', 'No managed control profile is configured for the canonical task.'));
    projection.alignment = 'LEGACY_COMPATIBLE';
    return {
      schema: 'brain.execution-readiness.v1', status: 'LEGACY_COMPATIBLE', ready: true, legacyCompatibility: true,
      reasons, advisories, canonicalTask: { taskId, sourceTaskRef: taskPath }, focus: null, governingSources: [], projection,
      managed: { status: 'NOT_READY', ready: false, available: managedProfile?.status === 'VALID', profileStatus: managedProfile?.status ?? 'MISSING', reasons: managedReasons }
    };
  }

  if (atlas.error) add(reason('ATLAS_UNAVAILABLE', 'The atlas profile could not be safely inspected.', { detail: String(atlas.error).slice(0, 300) }));
  if (atlas.structuralStatus !== 'VALID') add(reason('ATLAS_STRUCTURE_INVALID', 'The atlas structure is invalid; reconcile its profile before implementation.'));
  if (!taskId || task.taskId !== task.mappedTaskId || task.mappingChanged)
    add(reason('CURRENT_TASK_MAPPING_MISMATCH', 'The selected task does not match the canonical current-work contract and checkpoint.'));
  if (task.checkpointTaskId && task.checkpointTaskId !== task.mappedTaskId)
    add(reason('CHECKPOINT_TASK_MISMATCH', 'The current checkpoint names a different platform task; reconcile the checkpoint before implementation.'));
  if (!task.contractPresent) add(reason('CURRENT_TASK_CONTRACT_MISSING', 'The canonical current-work task contract is unavailable.'));
  if (task.authorization !== 'authorized') add(reason('CURRENT_TASK_UNAUTHORIZED', 'The canonical current task does not carry authorized implementation scope.'));
  if (!taskPath || !task.sourceTaskSafe)
    add(reason('CURRENT_TASK_SOURCE_UNSAFE', 'The canonical task source path is missing or could not be read safely.'));
  if (!atlas.profile || !Array.isArray(atlas.profile.nodes))
    add(reason('ATLAS_STRUCTURE_INVALID', 'The atlas has no usable planning nodes.'));
  if (!focusId || !focus) add(reason('PLANNING_FOCUS_MISSING', 'Choose an existing planning focus before implementation.'));
  else {
    if (focus.intentStatus !== 'accepted') add(reason('PLANNING_FOCUS_NOT_ACCEPTED', 'The planning focus must be accepted before implementation.'));
    const acceptance = Array.isArray(focus.acceptance) ? focus.acceptance.filter(item => typeof item === 'string' && item.trim()) : [];
    if (!acceptance.length) add(reason('PLANNING_FOCUS_ACCEPTANCE_MISSING', 'The planning focus needs at least one observable acceptance statement.'));
  }

  const governingNodeIds = new Set();
  const visit = node => {
    if (!node || governingNodeIds.has(node.id)) return;
    governingNodeIds.add(node.id);
    for (const dependencyId of Array.isArray(node.dependsOn) ? node.dependsOn : []) visit(byId.get(dependencyId));
  };
  if (focus) visit(focus);
  const governingSourceIds = new Set();
  for (const id of governingNodeIds) {
    const node = byId.get(id);
    for (const sourceId of Array.isArray(node?.sourceRefs) ? node.sourceRefs : []) governingSourceIds.add(sourceId);
  }
  const sourceRefs = Array.isArray(atlas.profile?.sourceRefs) ? atlas.profile.sourceRefs : [];
  const sourceById = new Map(sourceRefs.filter(source => source && typeof source.id === 'string').map(source => [source.id, source]));
  const checks = new Map((Array.isArray(atlas.sourceChecks) ? atlas.sourceChecks : []).filter(check => check && typeof check.id === 'string').map(check => [check.id, check]));
  const governingSources = [];
  for (const id of governingSourceIds) {
    const source = sourceById.get(id);
    const check = checks.get(id);
    if (!source) {
      add(reason('GOVERNING_SOURCE_MISSING', 'A focus or prerequisite source reference is missing from the atlas.', { sourceId: id }));
      governingSources.push({ id, path: null, state: 'MISSING' });
      continue;
    }
    const state = check?.state ?? 'NOT_INSPECTED';
    governingSources.push({ id, path: source.path, state });
    if (!sourceIsMatched(source, check)) add(reason('GOVERNING_SOURCE_NOT_CURRENT', 'A source governing the focus or its prerequisites needs explicit reconciliation.', { sourceId: id, path: source.path, state }));
  }
  const taskSourceLinks = focus && taskPath
    ? (Array.isArray(focus.sourceRefs) ? focus.sourceRefs : []).map(id => sourceById.get(id)).filter(source => source && normalizedProjectPath(source.path) === taskPath)
    : [];
  const taskLinkMismatch = Boolean(focus && taskPath && !taskSourceLinks.length);
  if (!taskSourceLinks.length) {
    add(reason('FOCUS_NOT_LINKED_TO_CURRENT_TASK', 'The selected focus must directly reference the exact canonical task source path.', { taskPath }));
  } else {
    for (const source of taskSourceLinks) {
      const check = checks.get(source.id);
      if (!sourceIsMatched(source, check))
        add(reason('CURRENT_TASK_SOURCE_NOT_CURRENT', 'The atlas pin for the canonical task must match its current source bytes.', { sourceId: source.id, path: source.path, state: check?.state ?? 'NOT_INSPECTED' }));
    }
  }

  const baseReady = reasons.length === 0;
  projection.alignment = baseReady ? 'ALIGNED' : taskLinkMismatch ? 'MISMATCHED' : 'NEEDS_RECONCILIATION';
  const managedReasons = reasons.slice();
  let profileStatus = managedProfile?.status ?? 'MISSING';
  if (profileStatus === 'MISSING') managedReasons.push(reason('MANAGED_PROFILE_MISSING', 'No managed control profile is configured for the canonical task.'));
  else if (profileStatus !== 'VALID') managedReasons.push(reason('MANAGED_PROFILE_INVALID', 'The managed control profile is invalid and cannot authorize candidate preparation.'));
  if (profileStatus === 'VALID' && focus && !managedProfile.planNodeIds?.includes(focus.id))
    managedReasons.push(reason('MANAGED_FOCUS_NOT_LINKED', 'The managed control profile must include the current accepted planning focus.'));
  const managedReady = baseReady && profileStatus === 'VALID' && managedProfile.planNodeIds?.includes(focus?.id);

  return {
    schema: 'brain.execution-readiness.v1', status: baseReady ? 'READY' : 'NOT_READY', ready: baseReady, legacyCompatibility: false,
    reasons, advisories, canonicalTask: { taskId, sourceTaskRef: taskPath },
    focus: focus ? { nodeId: focus.id, title: focus.title, acceptance: focus.acceptance } : null,
    governingSources, projection,
    managed: {
      status: managedReady ? 'READY' : 'NOT_READY', ready: Boolean(managedReady), available: profileStatus === 'VALID', profileStatus,
      reasons: managedReasons.slice(0, MAX_REASONS)
    }
  };
}
