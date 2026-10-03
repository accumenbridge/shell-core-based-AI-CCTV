import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { inspectAtlas } from './brain-atlas.mjs';
import { assessReadiness } from './brain-readiness.mjs';

const WORKFLOW = '.brain/workflow';
const PROJECT = '.brain/project.json';
const CONTRACTS = `${WORKFLOW}/contracts`;
const RECORDS = `${WORKFLOW}/runs`;
const EVENTS = `${WORKFLOW}/events`;
const ARTIFACTS = `${WORKFLOW}/artifacts`;
const CURRENT = `${WORKFLOW}/current.json`;
const RECIPES = `${WORKFLOW}/recipes.json`;
const VIEW = '.brain/CURRENT.md';
const ATLAS_PROFILE = '.brain/atlas/project.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const STATUS = new Set(['PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN', 'UNKNOWN']);
const CHECKPOINT_STATUS = new Set([
    'READY', 'IMPLEMENTING', 'REVIEW', 'ACCEPTED', 'BLOCKED', 'DEFERRED', 'IMPORTED', 'REPORTED_IN_PROGRESS'
]);
const GATE_STATUS = new Set(['PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN', 'UNKNOWN', 'DEFERRED', 'REPORTED']);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 8192;

export class BrainError extends Error {
    constructor(code, message, details = undefined) {
        super(message);
        this.name = 'BrainError';
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

function problem(code, message, details) {
    throw new BrainError(code, message, details);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, optional = [], label = 'object') {
    if (!isObject(value)) problem('INVALID_SCHEMA', `${label} must be a JSON object.`);
    const allowed = new Set([...required, ...optional]);
    for (const key of required)
        if (!Object.hasOwn(value, key)) problem('INVALID_SCHEMA', `${label}.${key} is required.`);
    const extras = Object.keys(value).filter(key => !allowed.has(key));
    if (extras.length) problem('INVALID_SCHEMA', `${label} has unsupported field(s): ${extras.join(', ')}.`);
}

function text(value, label, { max = MAX_TEXT, empty = false } = {}) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
        problem('INVALID_SCHEMA', `${label} must be ${empty ? 'a' : 'a non-empty'} string of at most ${max} characters.`);
    return value;
}

function stringList(value, label, { maxItems = 256, itemMax = 2048 } = {}) {
    if (!Array.isArray(value) || value.length > maxItems)
        problem('INVALID_SCHEMA', `${label} must be an array with at most ${maxItems} entries.`);
    const result = value.map((item, index) => text(item, `${label}[${index}]`, { max: itemMax }));
    if (new Set(result).size !== result.length) problem('INVALID_SCHEMA', `${label} must not contain duplicates.`);
    return result;
}

function number(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        problem('INVALID_SCHEMA', `${label} must be a safe integer from ${min} through ${max}.`);
    return value;
}

function sha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) problem('INVALID_SCHEMA', `${label} must be a lowercase SHA-256 digest.`);
    return value;
}

function iso(value, label, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
        problem('INVALID_SCHEMA', `${label} must be an ISO UTC timestamp${nullable ? ' or null' : ''}.`);
    return value;
}

export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (!isObject(value)) return JSON.stringify(value);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function digestJson(value) {
    return digest(Buffer.from(canonicalJson(value), 'utf8'));
}

function safeRelative(value, label, { allowDot = false } = {}) {
    text(value, label, { max: 1024 });
    if (allowDot && value === '.') return value;
    if (value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/') ||
        isAbsolute(value) || win32.isAbsolute(value))
        problem('PATH_OUTSIDE_ROOT', `${label} must be a repository-relative path using forward slashes.`);
    const pieces = value.split('/');
    if (!pieces.length || pieces.some(part => !part || part === '.' || part === '..'))
        problem('PATH_OUTSIDE_ROOT', `${label} must not contain empty, dot, or parent path components.`);
    return value;
}

function assertWithin(root, relativePath) {
    const absolute = resolve(root, ...relativePath.split('/'));
    const back = relative(root, absolute);
    if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back))
        problem('PATH_OUTSIDE_ROOT', `Path leaves the repository root: ${relativePath}`);
    return absolute;
}

async function checkedStat(root, rel, { kind, optional = false } = {}) {
    safeRelative(rel, 'path');
    const absolute = assertWithin(root, rel);
    const parts = rel.split('/');
    let cursor = root;
    for (let index = 0; index < parts.length; index++) {
        cursor = join(cursor, parts[index]);
        let info;
        try { info = await lstat(cursor); }
        catch (error) {
            if (optional && error.code === 'ENOENT') return null;
            throw error;
        }
        if (info.isSymbolicLink()) problem('SYMLINK_PATH', `Symbolic-link traversal is not allowed: ${parts.slice(0, index + 1).join('/')}`);
        if (index < parts.length - 1 && !info.isDirectory()) problem('INVALID_PATH_KIND', `Path parent is not a directory: ${parts.slice(0, index + 1).join('/')}`);
        if (index === parts.length - 1 && kind === 'file' && !info.isFile()) problem('INVALID_PATH_KIND', `Expected a regular file: ${rel}`);
        if (index === parts.length - 1 && kind === 'directory' && !info.isDirectory()) problem('INVALID_PATH_KIND', `Expected a directory: ${rel}`);
    }
    return { absolute, info: await lstat(absolute) };
}

function sameFileVersion(left, right) {
    if (!left?.isFile?.() || !right?.isFile?.() || left.dev !== right.dev) return false;
    if (left.ino && right.ino && left.ino !== right.ino) return false;
    return left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

/** Bounded same-handle primitive exposed for deterministic mutation-boundary tests; this tool is not a package API. */
export async function readBoundedHandle(handle, rel, initialStat, maxBytes) {
    if (initialStat.size > maxBytes) problem('INPUT_TOO_LARGE', `${rel} exceeds the ${maxBytes}-byte file limit.`);
    const readLimit = maxBytes + 1;
    const chunks = [];
    let total = 0;
    while (total < readLimit) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) problem('INPUT_TOO_LARGE', `${rel} exceeds the ${maxBytes}-byte file limit.`);
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    if (total !== initialStat.size || !sameFileVersion(initialStat, after))
        problem('INPUT_CHANGED', `${rel} changed while it was being read.`);
    return Buffer.concat(chunks, total);
}

async function safeRead(root, rel, { optional = false, maxBytes = MAX_JSON_BYTES } = {}) {
    const found = await checkedStat(root, rel, { kind: 'file', optional });
    if (!found) return null;
    if (found.info.size > maxBytes) problem('INPUT_TOO_LARGE', `${rel} exceeds the ${maxBytes}-byte file limit.`);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(found.absolute, flags);
    try {
        const opened = await handle.stat();
        if (!sameFileVersion(found.info, opened)) problem('INPUT_CHANGED', `${rel} changed before it could be read.`);
        const current = await checkedStat(root, rel, { kind: 'file' });
        if (!sameFileVersion(found.info, current.info) || !sameFileVersion(opened, current.info))
            problem('INPUT_CHANGED', `${rel} changed before it could be read.`);
        if (opened.size > maxBytes) problem('INPUT_TOO_LARGE', `${rel} exceeds the ${maxBytes}-byte file limit.`);
        const bytes = await readBoundedHandle(handle, rel, opened, maxBytes);
        const after = await checkedStat(root, rel, { kind: 'file' });
        if (!sameFileVersion(opened, after.info)) problem('INPUT_CHANGED', `${rel} changed after it was read.`);
        return bytes;
    } finally {
        await handle.close();
    }
}

async function readJson(root, rel, { optional = false } = {}) {
    const bytes = await safeRead(root, rel, { optional });
    if (!bytes) return null;
    try { return JSON.parse(bytes.toString('utf8')); }
    catch (error) { problem('INVALID_JSON', `${rel} is not valid JSON: ${error.message}`); }
}

async function ensureDirectory(root, rel) {
    safeRelative(rel, 'directory');
    let cursor = '';
    for (const part of rel.split('/')) {
        cursor = cursor ? `${cursor}/${part}` : part;
        const found = await checkedStat(root, cursor, { optional: true });
        if (!found) {
            try { await mkdir(assertWithin(root, cursor)); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
            await checkedStat(root, cursor, { kind: 'directory' });
        } else if (!found.info.isDirectory()) problem('INVALID_PATH_KIND', `Expected a directory: ${cursor}`);
    }
}

async function rootPath(inputRoot) {
    let root;
    try { root = await (await import('node:fs/promises')).realpath(resolve(inputRoot)); }
    catch (error) { problem('ROOT_UNAVAILABLE', `Cannot resolve repository root ${inputRoot}: ${error.message}`); }
    const info = await lstat(root);
    if (!info.isDirectory()) problem('ROOT_UNAVAILABLE', 'Repository root must be a directory.');
    return root;
}

async function readProject(root, { allowBootstrap = false } = {}) {
    const project = await readJson(root, PROJECT);
    exactKeys(project, ['schema', 'name', 'kind', 'repositories', 'canonical', 'execution', 'commands_file', 'policy_file', 'setup_status', 'note'], [], 'project map');
    if (project.schema !== 'brain.project-setup.v1') problem('INVALID_PROJECT_MAP', 'Unsupported project map schema.');
    exactKeys(project.canonical, ['brief', 'outcome', 'acceptance', 'strategy', 'decisions', 'progress', 'current_work'], [], 'project.canonical');
    safeRelative(project.canonical.current_work, 'project.canonical.current_work');
    safeRelative(project.canonical.progress, 'project.canonical.progress');
    if (project.commands_file !== RECIPES && !(allowBootstrap && project.commands_file === '.brain/checks.json'))
        problem('PROJECT_MAP_MISMATCH', `project.commands_file must point to ${RECIPES}.`);
    if (project.canonical.progress !== VIEW && !(allowBootstrap && project.canonical.progress === '.brain/PROGRESS.md'))
        problem('PROJECT_MAP_MISMATCH', `project.canonical.progress must point to generated ${VIEW}.`);
    return project;
}

function validateContract(contract, expectedTaskId) {
    exactKeys(contract, [
        'schema', 'taskId', 'title', 'authorization', 'sourceTaskRef', 'owners', 'allowedPaths', 'excludedActions',
        'prerequisites', 'criteria', 'requiredRecipeIds', 'reviewRequirement'
    ], ['requiredObservationRecipeIds'], 'task contract');
    if (contract.schema !== 'brain.task-contract.v1') problem('INVALID_CONTRACT', 'Unsupported task contract schema.');
    if (typeof contract.taskId !== 'string' || !TASK_RE.test(contract.taskId) || contract.taskId !== expectedTaskId)
        problem('INVALID_CONTRACT', `Contract taskId must match ${expectedTaskId}.`);
    text(contract.title, 'contract.title', { max: 240 });
    exactKeys(contract.authorization, ['kind', 'reference'], [], 'contract.authorization');
    if (!['authorized', 'reported_import', 'proposal'].includes(contract.authorization.kind))
        problem('INVALID_CONTRACT', 'contract.authorization.kind must be authorized, reported_import, or proposal.');
    text(contract.authorization.reference, 'contract.authorization.reference', { max: 2048 });
    safeRelative(contract.sourceTaskRef, 'contract.sourceTaskRef');
    exactKeys(contract.owners, ['coordinator', 'implementer', 'reviewer'], [], 'contract.owners');
    for (const role of ['coordinator', 'implementer', 'reviewer']) text(contract.owners[role], `contract.owners.${role}`, { max: 256 });
    const paths = stringList(contract.allowedPaths, 'contract.allowedPaths', { maxItems: 256, itemMax: 1024 });
    for (const path of paths) safeRelative(path, 'contract.allowedPaths[]');
    if (!paths.length) problem('INVALID_CONTRACT', 'contract.allowedPaths must include at least one exact candidate file.');
    stringList(contract.excludedActions, 'contract.excludedActions', { maxItems: 128 });
    stringList(contract.prerequisites, 'contract.prerequisites', { maxItems: 128 });
    if (!Array.isArray(contract.criteria) || !contract.criteria.length || contract.criteria.length > 256)
        problem('INVALID_CONTRACT', 'contract.criteria must contain 1 to 256 entries.');
    const criteriaIds = new Set();
    for (const [index, criterion] of contract.criteria.entries()) {
        exactKeys(criterion, ['id', 'description', 'evidenceScope'], [], `contract.criteria[${index}]`);
        const id = text(criterion.id, `contract.criteria[${index}].id`, { max: 128 });
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || criteriaIds.has(id)) problem('INVALID_CONTRACT', `Invalid or duplicate criterion id ${id}.`);
        criteriaIds.add(id);
        text(criterion.description, `contract.criteria[${index}].description`, { max: 2048 });
        text(criterion.evidenceScope, `contract.criteria[${index}].evidenceScope`, { max: 2048 });
    }
    stringList(contract.requiredRecipeIds, 'contract.requiredRecipeIds', { maxItems: 256, itemMax: 128 });
    if (contract.requiredObservationRecipeIds !== undefined)
        stringList(contract.requiredObservationRecipeIds, 'contract.requiredObservationRecipeIds', { maxItems: 256, itemMax: 128 });
    exactKeys(contract.reviewRequirement, ['required', 'independence'], [], 'contract.reviewRequirement');
    if (typeof contract.reviewRequirement.required !== 'boolean' || !['none', 'independent_reported'].includes(contract.reviewRequirement.independence))
        problem('INVALID_CONTRACT', 'contract.reviewRequirement has invalid required or independence values.');
    if (contract.reviewRequirement.required !== (contract.reviewRequirement.independence !== 'none'))
        problem('INVALID_CONTRACT', 'A required review must name its independence level, and an optional review must use none.');
    return contract;
}

function validateRecipeCatalog(catalog) {
    exactKeys(catalog, ['schema', 'recipes'], [], 'recipe catalog');
    if (catalog.schema !== 'brain.recipe-catalog.v1' || !Array.isArray(catalog.recipes) || catalog.recipes.length > 512)
        problem('INVALID_RECIPE_CATALOG', 'Unsupported or malformed recipe catalog.');
    const ids = new Set();
    for (const [index, recipe] of catalog.recipes.entries()) {
        exactKeys(recipe, ['id', 'argv', 'cwd', 'description', 'criterionIds', 'evidenceScope'], [], `recipe[${index}]`);
        const id = text(recipe.id, `recipe[${index}].id`, { max: 128 });
        if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id)) problem('INVALID_RECIPE_CATALOG', `Invalid or duplicate recipe id ${id}.`);
        ids.add(id);
        if (!Array.isArray(recipe.argv) || recipe.argv.length < 1 || recipe.argv.length > 64)
            problem('INVALID_RECIPE_CATALOG', `${id}.argv must contain 1 to 64 inert argument strings.`);
        recipe.argv.forEach((arg, argIndex) => text(arg, `${id}.argv[${argIndex}]`, { max: 2048, empty: true }));
        safeRelative(recipe.cwd, `${id}.cwd`, { allowDot: true });
        text(recipe.description, `${id}.description`, { max: 2048 });
        stringList(recipe.criterionIds, `${id}.criterionIds`, { maxItems: 256, itemMax: 128 });
        text(recipe.evidenceScope, `${id}.evidenceScope`, { max: 2048 });
    }
    return catalog;
}

function validateCandidate(candidate, allowedPaths = undefined) {
    exactKeys(candidate, ['files', 'digest'], [], 'candidate');
    if (!Array.isArray(candidate.files) || candidate.files.length > 1024 || (allowedPaths && candidate.files.length !== allowedPaths.length))
        problem('INVALID_CANDIDATE', 'Candidate files must list the explicit candidate paths within the supported bound.');
    const files = [];
    for (const [index, file] of candidate.files.entries()) {
        exactKeys(file, ['path', 'sha256'], [], `candidate.files[${index}]`);
        safeRelative(file.path, `candidate.files[${index}].path`);
        sha(file.sha256, `candidate.files[${index}].sha256`);
        files.push({ path: file.path, sha256: file.sha256 });
    }
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (canonicalJson(files) !== canonicalJson(sorted)) problem('INVALID_CANDIDATE', 'Candidate files must be sorted by path.');
    if (new Set(files.map(file => file.path)).size !== files.length || (allowedPaths && files.some(file => !allowedPaths.includes(file.path))))
        problem('INVALID_CANDIDATE', 'Candidate contains duplicate or out-of-contract paths.');
    if (allowedPaths && allowedPaths.some(path => !files.some(file => file.path === path)))
        problem('INVALID_CANDIDATE', 'Candidate does not contain every exact contract path.');
    const expected = candidateDigest(files);
    if (candidate.digest !== expected) problem('INVALID_CANDIDATE', 'Candidate aggregate digest does not match its explicit file hashes.');
    return { files, digest: expected };
}

export function candidateDigest(files) {
    const hash = createHash('sha256');
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')))
        hash.update(`${file.path}\0${file.sha256}\n`, 'utf8');
    return hash.digest('hex');
}

async function computeCandidate(root, contract) {
    const files = [];
    const paths = [...contract.allowedPaths].sort((a, b) => a.localeCompare(b, 'en'));
    for (const path of paths) {
        const found = await checkedStat(root, path, { kind: 'file' });
        const bytes = await readFile(found.absolute);
        files.push({ path, sha256: digest(bytes) });
    }
    return { files, digest: candidateDigest(files) };
}

function validateCounts(counts) {
    exactKeys(counts, ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'], [], 'counts');
    for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']) number(counts[key], `counts.${key}`);
    if (counts.tests !== counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo)
        problem('INVALID_COUNTS', 'counts.tests must equal the sum of all result categories.');
    return counts;
}

function validateEnvironment(environment) {
    if (!isObject(environment) || Object.keys(environment).length > 32) problem('INVALID_SCHEMA', 'environment must be a flat object with at most 32 entries.');
    for (const [key, value] of Object.entries(environment)) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) problem('INVALID_SCHEMA', `Invalid environment key ${key}.`);
        text(value, `environment.${key}`, { max: 1024, empty: true });
    }
    return environment;
}

function validateProvenance(provenance) {
    exactKeys(provenance, ['kind', 'reference'], [], 'provenance');
    if (provenance.kind !== 'reported') problem('INVALID_SCHEMA', 'provenance.kind must be reported; records do not authenticate execution or approval.');
    text(provenance.reference, 'provenance.reference', { max: 2048 });
    return provenance;
}

function validateRecordInput(input) {
    if (!isObject(input) || input.schema !== 'brain.record-input.v1') problem('INVALID_RECORD_INPUT', 'Record input must use brain.record-input.v1.');
    if (input.kind === 'run') {
        exactKeys(input, ['schema', 'kind', 'taskId', 'recipeId', 'status', 'exitCode', 'environment', 'artifactPaths', 'provenance', 'limitations'], ['counts', 'candidate', 'resolution'], 'run input');
        if (!TASK_RE.test(input.taskId)) problem('INVALID_RECORD_INPUT', 'run input.taskId is invalid.');
        text(input.recipeId, 'run input.recipeId', { max: 128 });
        if (!STATUS.has(input.status)) problem('INVALID_RECORD_INPUT', `Unsupported run status ${input.status}.`);
        if (input.exitCode !== null) number(input.exitCode, 'run input.exitCode', { min: -255, max: 255 });
        if (input.status === 'NOT_RUN' && input.exitCode !== null) problem('INVALID_RECORD_INPUT', 'NOT_RUN runs must have a null exitCode.');
        if (input.status === 'PASSED' && input.exitCode !== 0) problem('INVALID_RECORD_INPUT', 'PASSED runs require exitCode 0.');
        validateEnvironment(input.environment);
        if (input.counts !== undefined) {
            validateCounts(input.counts);
            if (input.status === 'PASSED' && (input.counts.failed || input.counts.cancelled || input.counts.skipped || input.counts.todo))
                problem('INVALID_RECORD_INPUT', 'PASSED runs cannot report failed, cancelled, skipped, or TODO cases.');
        }
        if (!Array.isArray(input.artifactPaths) || input.artifactPaths.length > 64) problem('INVALID_RECORD_INPUT', 'artifactPaths must be an array with at most 64 paths.');
        input.artifactPaths.forEach(path => safeRelative(path, 'artifactPaths[]'));
        stringList(input.limitations, 'run input.limitations', { maxItems: 128 });
        validateProvenance(input.provenance);
        if (input.candidate !== undefined && input.candidate !== null && !isObject(input.candidate)) problem('INVALID_CANDIDATE', 'candidate must be an explicit candidate object or null.');
    } else if (input.kind === 'review') {
        exactKeys(input, ['schema', 'kind', 'taskId', 'reviewer', 'implementer', 'independence', 'outcome', 'scope', 'artifactPaths', 'provenance', 'limitations'], ['candidate', 'resolution'], 'review input');
        if (!TASK_RE.test(input.taskId)) problem('INVALID_RECORD_INPUT', 'review input.taskId is invalid.');
        text(input.reviewer, 'review input.reviewer', { max: 256 });
        text(input.implementer, 'review input.implementer', { max: 256 });
        if (!['independent_reported', 'self', 'unknown'].includes(input.independence)) problem('INVALID_RECORD_INPUT', 'review input.independence is invalid.');
        if (!['ACCEPTED', 'CHANGES_REQUESTED', 'BLOCKED', 'DEFERRED', 'UNKNOWN'].includes(input.outcome)) problem('INVALID_RECORD_INPUT', 'review input.outcome is invalid.');
        text(input.scope, 'review input.scope', { max: 2048 });
        if (!Array.isArray(input.artifactPaths) || input.artifactPaths.length > 64) problem('INVALID_RECORD_INPUT', 'artifactPaths must be an array with at most 64 paths.');
        input.artifactPaths.forEach(path => safeRelative(path, 'artifactPaths[]'));
        stringList(input.limitations, 'review input.limitations', { maxItems: 128 });
        validateProvenance(input.provenance);
        if (input.candidate !== undefined && input.candidate !== null && !isObject(input.candidate)) problem('INVALID_CANDIDATE', 'candidate must be an explicit candidate object or null.');
    } else {
        problem('INVALID_RECORD_INPUT', 'Record kind must be run or review.');
    }
    if (input.resolution !== undefined) validateResolution(input.resolution);
    return input;
}

function validateResolution(resolution) {
    exactKeys(resolution, ['recordIds', 'reason'], [], 'resolution');
    const ids = stringList(resolution.recordIds, 'resolution.recordIds', { maxItems: 128, itemMax: 36 });
    if (!ids.length || ids.some(id => !UUID_RE.test(id))) problem('INVALID_RESOLUTION', 'A resolution must name existing evidence record IDs.');
    text(resolution.reason, 'resolution.reason', { max: 2048 });
}

function validateResolutions(records) {
    const byId = new Map(records.map(record => [record.id, record]));
    for (const record of records) {
        if (!record.resolution) continue;
        validateResolution(record.resolution);
        if ((record.kind === 'run' ? record.status !== 'PASSED' : record.outcome !== 'ACCEPTED') || !record.artifacts.length)
            problem('INVALID_RESOLUTION', 'A resolution requires a positive result and supporting artifacts.');
        for (const id of record.resolution.recordIds) {
            const prior = byId.get(id);
            const sameScope = prior && prior.kind === record.kind && prior.taskId === record.taskId &&
                prior.contractDigest === record.contractDigest && canonicalJson(prior.candidate) === canonicalJson(record.candidate) &&
                prior.recordedAt <= record.recordedAt && (record.kind === 'run'
                    ? prior.recipeId === record.recipeId && prior.recipeDigest === record.recipeDigest && ['FAILED', 'BLOCKED', 'UNKNOWN'].includes(prior.status)
                    : prior.reviewer === record.reviewer && prior.implementer === record.implementer && prior.scope === record.scope &&
                        prior.independence === record.independence && ['CHANGES_REQUESTED', 'BLOCKED'].includes(prior.outcome));
            if (!sameScope) problem('INVALID_RESOLUTION', `Resolution ${record.id} cannot resolve ${id}: missing, later or different evidence scope.`);
        }
    }
}

function validateEmittedRecord(record, id, definitions) {
    if (!isObject(record) || record.schema !== 'brain.evidence-record.v1') problem('INVALID_RECORD', `Record ${id} has an unsupported schema.`);
    if (record.id !== id || !UUID_RE.test(record.id)) problem('INVALID_RECORD', `Record filename and id do not match: ${id}.`);
    if (!TASK_RE.test(record.taskId)) problem('INVALID_RECORD', `Record ${id} has an invalid taskId.`);
    const contract = definitions.contracts.get(record.taskId);
    sha(record.contractDigest, `record ${id}.contractDigest`);
    const integritySha256 = sha(record.integritySha256, `record ${id}.integritySha256`);
    const unsignedRecord = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'integritySha256'));
    if (digestJson(unsignedRecord) !== integritySha256) problem('RECORD_INTEGRITY', `Record ${id} content checksum does not match.`);
    const candidate = validateCandidate(record.candidate,
        contract && digest(definitions.contractBytes.get(record.taskId)) === record.contractDigest ? contract.allowedPaths : undefined);
    iso(record.recordedAt, `record ${id}.recordedAt`);
    stringList(record.limitations, `record ${id}.limitations`, { maxItems: 128 });
    validateProvenance(record.provenance);
    if (!Array.isArray(record.artifacts) || record.artifacts.length > 64) problem('INVALID_RECORD', `Record ${id}.artifacts must be an array with at most 64 entries.`);
    const artPaths = new Set();
    for (const [index, artifact] of record.artifacts.entries()) {
        exactKeys(artifact, ['sourceRef', 'path', 'sha256', 'bytes'], [], `record ${id}.artifacts[${index}]`);
        safeRelative(artifact.sourceRef, `record ${id}.artifacts.sourceRef`);
        safeRelative(artifact.path, `record ${id}.artifacts.path`);
        if (!artifact.path.startsWith(`${ARTIFACTS}/${id}/`)) problem('INVALID_RECORD', `Record ${id} artifact path is outside its immutable artifact directory.`);
        sha(artifact.sha256, `record ${id}.artifacts.sha256`);
        number(artifact.bytes, `record ${id}.artifacts.bytes`, { max: MAX_ARTIFACT_BYTES });
        if (artPaths.has(artifact.path)) problem('INVALID_RECORD', `Record ${id} has duplicate artifact paths.`);
        artPaths.add(artifact.path);
    }
    if (record.kind === 'run') {
        exactKeys(record, ['schema', 'kind', 'id', 'taskId', 'recipeId', 'contractDigest', 'recipeDigest', 'candidate', 'recordedAt', 'command', 'environment', 'status', 'exitCode', 'artifacts', 'provenance', 'limitations', 'integritySha256'], ['counts', 'resolution'], `run record ${id}`);
        text(record.recipeId, `run ${id}.recipeId`, { max: 128 });
        const recipe = definitions.recipes.get(record.recipeId);
        sha(record.recipeDigest, `run ${id}.recipeDigest`);
        exactKeys(record.command, ['argv', 'cwd'], [], `run ${id}.command`);
        if (!Array.isArray(record.command.argv) || record.command.argv.length < 1 || record.command.argv.length > 64)
            problem('INVALID_RECORD', `Run ${id} command.argv must contain inert argument strings.`);
        record.command.argv.forEach((arg, index) => text(arg, `run ${id}.command.argv[${index}]`, { max: 2048, empty: true }));
        safeRelative(record.command.cwd, `run ${id}.command.cwd`, { allowDot: true });
        if (recipe && digestJson(recipe) === record.recipeDigest &&
            (canonicalJson(record.command.argv) !== canonicalJson(recipe.argv) || record.command.cwd !== recipe.cwd))
            problem('INVALID_RECORD', `Run ${id} command does not match its inert recipe definition.`);
        validateEnvironment(record.environment);
        if (!STATUS.has(record.status)) problem('INVALID_RECORD', `Run ${id} has an invalid status.`);
        if (record.exitCode !== null) number(record.exitCode, `run ${id}.exitCode`, { min: -255, max: 255 });
        if (record.status === 'PASSED' && record.exitCode !== 0) problem('INVALID_RECORD', `PASSED run ${id} must have exitCode 0.`);
        if (record.status === 'NOT_RUN' && record.exitCode !== null) problem('INVALID_RECORD', `NOT_RUN run ${id} must have null exitCode.`);
        if (record.counts !== undefined) {
            validateCounts(record.counts);
            if (record.status === 'PASSED' && (record.counts.failed || record.counts.cancelled || record.counts.skipped || record.counts.todo))
                problem('INVALID_RECORD', `PASSED run ${id} reports failed, cancelled, skipped, or TODO cases.`);
        }
    } else if (record.kind === 'review') {
        exactKeys(record, ['schema', 'kind', 'id', 'taskId', 'contractDigest', 'candidate', 'recordedAt', 'reviewer', 'implementer', 'independence', 'outcome', 'scope', 'artifacts', 'provenance', 'limitations', 'integritySha256'], ['resolution'], `review record ${id}`);
        text(record.reviewer, `review ${id}.reviewer`, { max: 256 });
        text(record.implementer, `review ${id}.implementer`, { max: 256 });
        if (!['independent_reported', 'self', 'unknown'].includes(record.independence)) problem('INVALID_RECORD', `Review ${id} has invalid independence.`);
        if (!['ACCEPTED', 'CHANGES_REQUESTED', 'BLOCKED', 'DEFERRED', 'UNKNOWN'].includes(record.outcome)) problem('INVALID_RECORD', `Review ${id} has invalid outcome.`);
        text(record.scope, `review ${id}.scope`, { max: 2048 });
    } else problem('INVALID_RECORD', `Record ${id} kind must be run or review.`);
    return { record, contract, candidate };
}

async function loadDefinitions(root, { allowBootstrap = false } = {}) {
    const project = await readProject(root, { allowBootstrap });
    const catalog = validateRecipeCatalog(await readJson(root, RECIPES));
    const recipes = new Map(catalog.recipes.map(recipe => [recipe.id, recipe]));
    const contracts = new Map();
    const contractBytes = new Map();
    const contractDir = `${CONTRACTS}`;
    const entries = await readdir(assertWithin(root, contractDir), { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isSymbolicLink()) problem('SYMLINK_PATH', `Contract directory contains a symbolic link: ${entry.name}`);
        if (!entry.isFile() || !entry.name.endsWith('.json')) problem('INVALID_CONTRACT', `Unexpected entry in contracts/: ${entry.name}`);
        const id = entry.name.slice(0, -5);
        if (!TASK_RE.test(id)) problem('INVALID_CONTRACT', `Invalid contract filename ${entry.name}.`);
        const rel = `${CONTRACTS}/${entry.name}`;
        const bytes = await safeRead(root, rel);
        const contract = validateContract(JSON.parse(bytes.toString('utf8')), id);
        for (const recipeId of [...contract.requiredRecipeIds, ...(contract.requiredObservationRecipeIds ?? [])])
            if (!recipes.has(recipeId)) problem('INVALID_CONTRACT', `${id} requires unknown recipe ${recipeId}.`);
        const linkedRecipes = [...contract.requiredRecipeIds, ...(contract.requiredObservationRecipeIds ?? [])];
        for (const recipeId of linkedRecipes) {
            const recipe = recipes.get(recipeId);
            if (recipe.criterionIds.some(criterionId => !contract.criteria.some(criterion => criterion.id === criterionId)))
                problem('INVALID_RECIPE_CATALOG', `Recipe ${recipe.id} names a criterion absent from ${id}.`);
        }
        if (contract.authorization.kind === 'authorized') {
            const covered = new Set(linkedRecipes.flatMap(recipeId => recipes.get(recipeId).criterionIds));
            const missing = contract.criteria.filter(criterion => !covered.has(criterion.id)).map(criterion => criterion.id);
            if (missing.length) problem('INVALID_CONTRACT', `${id} has criteria without a required or observation recipe: ${missing.join(', ')}.`);
        }
        contracts.set(id, contract);
        contractBytes.set(id, bytes);
    }
    if (contracts.size === 0) problem('INVALID_CONTRACT', 'No task contracts were found.');
    return { project, catalog, recipes, contracts, contractBytes };
}

function assessEvidence(contract, candidate, contractDigestValue, records, runIds, reviewIds, recipes) {
    const reasons = [];
    if (contract.authorization.kind !== 'authorized')
        reasons.push(`authorization_not_granted:${contract.authorization.kind}`);
    const byId = new Map(records.map(record => [record.id, record]));
    const selectedRuns = runIds.map(id => byId.get(id)).filter(Boolean).filter(record => record.kind === 'run');
    const selectedReviews = reviewIds.map(id => byId.get(id)).filter(Boolean).filter(record => record.kind === 'review');
    const matching = record => record.taskId === contract.taskId && record.contractDigest === contractDigestValue &&
        canonicalJson(record.candidate) === canonicalJson(candidate);
    const resolved = new Set([...selectedRuns, ...selectedReviews].filter(matching).flatMap(record => record.resolution?.recordIds ?? []));
    for (const recipeId of contract.requiredRecipeIds) {
        const recipe = recipes.get(recipeId);
        for (const record of records.filter(record => matching(record) && record.kind === 'run' && record.recipeId === recipeId &&
            recipe && record.recipeDigest === digestJson(recipe) && ['FAILED', 'BLOCKED', 'UNKNOWN'].includes(record.status) && !resolved.has(record.id)))
            reasons.push(`unresolved_required_run:${recipeId}:${record.id}`);
        const passed = selectedRuns.some(record => matching(record) && record.recipeId === recipeId && record.status === 'PASSED' && record.exitCode === 0 &&
            recipe && record.recipeDigest === digestJson(recipe) &&
            (!record.counts || (record.counts.failed === 0 && record.counts.cancelled === 0 && record.counts.skipped === 0 && record.counts.todo === 0)));
        if (!passed) reasons.push(`required_recipe_not_qualified:${recipeId}`);
    }
    for (const recipeId of contract.requiredObservationRecipeIds ?? []) {
        const recipe = recipes.get(recipeId);
        const observed = selectedRuns.some(record => matching(record) && record.recipeId === recipeId &&
            recipe && record.recipeDigest === digestJson(recipe) &&
            ['PASSED', 'FAILED', 'BLOCKED'].includes(record.status) && Number.isSafeInteger(record.exitCode) && record.artifacts.length > 0);
        if (!observed) reasons.push(`required_observation_missing:${recipeId}`);
    }
    if (contract.reviewRequirement.required) {
        for (const record of records.filter(record => matching(record) && record.kind === 'review' &&
            ['CHANGES_REQUESTED', 'BLOCKED'].includes(record.outcome) && !resolved.has(record.id)))
            reasons.push(`unresolved_review:${record.id}`);
        const reviewed = selectedReviews.some(record => matching(record) && record.outcome === 'ACCEPTED' &&
            record.implementer === contract.owners.implementer && record.independence === contract.reviewRequirement.independence &&
            (record.independence !== 'independent_reported' || record.reviewer !== record.implementer));
        if (!reviewed) reasons.push('required_review_not_qualified');
    }
    return { status: reasons.length ? 'NOT_QUALIFIED' : 'QUALIFYING_REPORTED_EVIDENCE', reasons };
}

function mappedPlatformContractId(definitions) {
    const matches = [...definitions.contracts.values()].filter(contract => contract.sourceTaskRef === definitions.project.canonical.current_work);
    if (matches.length !== 1)
        problem('MAPPED_TASK_CONTRACT_MISMATCH', `project.canonical.current_work must match exactly one task contract sourceTaskRef; found ${matches.length}.`);
    return matches[0].taskId;
}

async function readinessAtlas(root) {
    try {
        const bytes = await safeRead(root, ATLAS_PROFILE, { optional: true });
        if (!bytes) return null;
    } catch (error) {
        return { present: true, error: error.message, structuralStatus: 'INVALID', profile: null, sourceChecks: [] };
    }
    try {
        const inspection = await inspectAtlas(root);
        return {
            present: true, profile: inspection.profile, structuralStatus: inspection.structuralStatus,
            sourceStatus: inspection.sourceStatus, sourceChecks: inspection.sourceChecks, errors: inspection.errors
        };
    } catch (error) {
        return { present: true, error: error.message, structuralStatus: 'INVALID', profile: null, sourceChecks: [] };
    }
}

async function currentReadiness(root, definitions, event) {
    const mappedTaskId = mappedPlatformContractId(definitions);
    const contract = definitions.contracts.get(mappedTaskId);
    let sourceTaskSafe = false;
    if (contract?.sourceTaskRef) {
        try { await safeRead(root, contract.sourceTaskRef); sourceTaskSafe = true; }
        catch { sourceTaskSafe = false; }
    }
    const checkpointTask = event?.platformTask ?? null;
    const task = {
        taskId: mappedTaskId,
        mappedTaskId,
        contractPresent: Boolean(contract),
        title: contract?.title ?? null,
        sourceTaskRef: contract?.sourceTaskRef ?? definitions.project.canonical.current_work,
        sourceTaskSafe,
        authorization: contract?.authorization.kind ?? 'missing',
        mappingChanged: Boolean(checkpointTask && checkpointTask.taskId !== mappedTaskId),
        checkpointTaskId: checkpointTask?.taskId ?? null,
        checkpointStatus: checkpointTask ? (checkpointTask.taskId === mappedTaskId ? checkpointTask.status : 'MISMATCH') : 'NOT_INITIALIZED'
    };
    const atlas = await readinessAtlas(root);
    const readiness = assessReadiness({ atlas, task });
    return {
        atlas,
        task,
        readiness,
        projection: readiness.projection
    };
}

function checkTransition(previousEvent, nextStates) {
    const prior = new Map();
    for (const state of [previousEvent?.platformTask, previousEvent?.maintenanceTask].filter(Boolean)) prior.set(state.taskId, state);
    const allowed = {
        READY: new Set(['IMPLEMENTING', 'BLOCKED', 'DEFERRED']),
        IMPLEMENTING: new Set(['REVIEW', 'BLOCKED', 'DEFERRED']),
        REVIEW: new Set(['IMPLEMENTING', 'ACCEPTED', 'BLOCKED', 'DEFERRED']),
        BLOCKED: new Set(['IMPLEMENTING']),
        DEFERRED: new Set(['IMPLEMENTING']),
        IMPORTED: new Set(['REPORTED_IN_PROGRESS', 'BLOCKED', 'DEFERRED']),
        REPORTED_IN_PROGRESS: new Set(['BLOCKED', 'DEFERRED']),
        ACCEPTED: new Set()
    };
    for (const state of nextStates) {
        const old = prior.get(state.taskId);
        if (!old) {
            if (!['READY', 'IMPLEMENTING', 'IMPORTED', 'REPORTED_IN_PROGRESS'].includes(state.status))
                problem('INVALID_TRANSITION', `${state.taskId} cannot begin directly in ${state.status}.`);
            continue;
        }
        if (old.status === state.status) continue;
        if (!allowed[old.status]?.has(state.status))
            problem('INVALID_TRANSITION', `${state.taskId} cannot transition ${old.status} -> ${state.status}.`);
    }
}

async function verifyImportDigests(root, states, previousEvent) {
    const prior = new Map([previousEvent?.platformTask, previousEvent?.maintenanceTask].filter(Boolean).map(state => [state.taskId, state.importProvenance]));
    for (const state of states) {
        const source = state.importProvenance;
        if (!source?.sourceSha256) continue;
        if (canonicalJson(prior.get(state.taskId) ?? null) === canonicalJson(source)) continue;
        const bytes = await safeRead(root, source.sourceRef);
        if (digest(bytes) !== source.sourceSha256)
            problem('IMPORT_PROVENANCE_MISMATCH', `Imported source digest does not match ${source.sourceRef}.`);
    }
}

function validateImportProvenance(provenance) {
    exactKeys(provenance, ['sourceRef', 'sourceSha256', 'originalStatus', 'observedAt', 'limitations'], [], 'importProvenance');
    safeRelative(provenance.sourceRef, 'importProvenance.sourceRef');
    if (provenance.sourceSha256 !== null) sha(provenance.sourceSha256, 'importProvenance.sourceSha256');
    text(provenance.originalStatus, 'importProvenance.originalStatus', { max: 128 });
    iso(provenance.observedAt, 'importProvenance.observedAt', true);
    stringList(provenance.limitations, 'importProvenance.limitations', { maxItems: 128 });
    return provenance;
}

function validateGateList(gates) {
    if (!Array.isArray(gates) || gates.length > 128) problem('INVALID_CHECKPOINT', 'gates must be an array with at most 128 entries.');
    const ids = new Set();
    return gates.map((gate, index) => {
        exactKeys(gate, ['id', 'status', 'evidenceRefs', 'limitations'], [], `gates[${index}]`);
        const id = text(gate.id, `gates[${index}].id`, { max: 128 });
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || ids.has(id)) problem('INVALID_CHECKPOINT', `Invalid or duplicate gate id ${id}.`);
        ids.add(id);
        if (!GATE_STATUS.has(gate.status)) problem('INVALID_CHECKPOINT', `Gate ${id} has an invalid status.`);
        const refs = stringList(gate.evidenceRefs, `gates[${index}].evidenceRefs`, { maxItems: 64, itemMax: 1024 });
        refs.forEach(ref => safeRelative(ref, `gate ${id} evidence ref`));
        const limitations = stringList(gate.limitations, `gates[${index}].limitations`, { maxItems: 64 });
        return { id, status: gate.status, evidenceRefs: refs, limitations };
    });
}

function validateTaskState(state, label, contracts, { historical = false } = {}) {
    exactKeys(state, ['taskId', 'status', 'candidate', 'runIds', 'reviewIds', 'blockers', 'nextAction', 'gates'], ['importProvenance'], label);
    if (!TASK_RE.test(state.taskId)) problem('INVALID_CHECKPOINT', `${label}.taskId is invalid.`);
    if (!CHECKPOINT_STATUS.has(state.status)) problem('INVALID_CHECKPOINT', `${label}.status is invalid.`);
    if (state.candidate !== null && state.candidate !== undefined) {
        if (!isObject(state.candidate)) problem('INVALID_CHECKPOINT', `${label}.candidate must be a candidate or null.`);
        const contract = contracts.get(state.taskId);
        validateCandidate(state.candidate, !historical && state.status === 'ACCEPTED' && contract ? contract.allowedPaths : undefined);
    }
    if (state.candidate === undefined) problem('INVALID_CHECKPOINT', `${label}.candidate is required; use null for imported or not-yet-bound state.`);
    const runIds = stringList(state.runIds, `${label}.runIds`, { maxItems: 512, itemMax: 36 });
    const reviewIds = stringList(state.reviewIds, `${label}.reviewIds`, { maxItems: 512, itemMax: 36 });
    for (const id of [...runIds, ...reviewIds]) if (!UUID_RE.test(id)) problem('INVALID_CHECKPOINT', `${label} contains invalid record id ${id}.`);
    const blockers = stringList(state.blockers, `${label}.blockers`, { maxItems: 128 });
    text(state.nextAction, `${label}.nextAction`, { max: 2048 });
    const gates = validateGateList(state.gates);
    if (state.importProvenance !== undefined) validateImportProvenance(state.importProvenance);
    if (['IMPORTED', 'REPORTED_IN_PROGRESS'].includes(state.status) && !state.importProvenance)
        problem('INVALID_CHECKPOINT', `${label} imported statuses require importProvenance.`);
    return { ...state, runIds, reviewIds, blockers, gates };
}

async function readAllRecords(root, definitions) {
    let entries;
    try { entries = await readdir(assertWithin(root, RECORDS), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const entry of entries) {
        if (entry.isSymbolicLink()) problem('SYMLINK_PATH', `Record directory contains a symbolic link: ${entry.name}`);
        if (!entry.isFile() || !entry.name.endsWith('.json')) problem('INVALID_RECORD', `Unexpected entry in runs/: ${entry.name}`);
        const id = entry.name.slice(0, -5);
        if (!UUID_RE.test(id)) problem('INVALID_RECORD', `Invalid record filename ${entry.name}.`);
        const rel = `${RECORDS}/${entry.name}`;
        const bytes = await safeRead(root, rel);
        let record;
        try { record = JSON.parse(bytes.toString('utf8')); }
        catch (error) { problem('INVALID_JSON', `${rel} is not valid JSON: ${error.message}`); }
        validateEmittedRecord(record, id, definitions);
        await validateRecordArtifacts(root, record);
        records.push(record);
    }
    validateResolutions(records);
    return records;
}

async function validateRecordArtifacts(root, record) {
    for (const artifact of record.artifacts) {
        const copy = await safeRead(root, artifact.path, { maxBytes: MAX_ARTIFACT_BYTES });
        if (!copy || copy.length !== artifact.bytes || digest(copy) !== artifact.sha256)
            problem('ARTIFACT_INTEGRITY', `Copied evidence failed integrity validation: ${artifact.path}`);
    }
}

async function readRecordById(root, id, definitions) {
    if (!UUID_RE.test(id)) problem('INVALID_RECORD', `Invalid record id ${id}.`);
    const bytes = await safeRead(root, `${RECORDS}/${id}.json`);
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); }
    catch (error) { problem('INVALID_JSON', `Record ${id} is not valid JSON: ${error.message}`); }
    validateEmittedRecord(record, id, definitions);
    await validateRecordArtifacts(root, record);
    return record;
}

async function readEvents(root, definitions, records, pointer) {
    let entries;
    try { entries = await readdir(assertWithin(root, EVENTS), { withFileTypes: true }); }
    catch (error) {
        if (error.code === 'ENOENT' && !pointer) return { events: [], orphanEventIds: [] };
        throw error;
    }
    const recordMap = new Map(records.map(record => [record.id, record]));
    const available = new Set();
    for (const entry of entries) {
        if (entry.isSymbolicLink()) problem('SYMLINK_PATH', `Event directory contains a symbolic link: ${entry.name}`);
        if (!entry.isFile() || !entry.name.endsWith('.json')) problem('INVALID_EVENT', `Unexpected entry in events/: ${entry.name}`);
        const id = entry.name.slice(0, -5);
        if (!UUID_RE.test(id)) problem('INVALID_EVENT', `Invalid event filename ${entry.name}.`);
        available.add(id);
    }
    const events = [];
    const reached = new Set();
    let nextId = pointer?.eventId ?? null;
    let expectedRevision = pointer?.revision ?? 0;
    while (nextId) {
        if (reached.has(nextId)) problem('EVENT_CHAIN_INVALID', `Checkpoint event chain contains a cycle at ${nextId}.`);
        if (!available.has(nextId)) problem('MISSING_CURRENT_EVENT', `Checkpoint chain references missing event ${nextId}.`);
        reached.add(nextId);
        const rel = `${EVENTS}/${nextId}.json`;
        const bytes = await safeRead(root, rel);
        let event;
        try { event = JSON.parse(bytes.toString('utf8')); }
        catch (error) { problem('INVALID_JSON', `${rel} is not valid JSON: ${error.message}`); }
        exactKeys(event, ['schema', 'id', 'revision', 'previousEventId', 'reportedActor', 'recordedAt', 'platformTask', 'integritySha256'], ['maintenanceTask'], `event ${nextId}`);
        if (event.schema !== 'brain.checkpoint-event.v1' || event.id !== nextId) problem('INVALID_EVENT', `Event ${nextId} has a schema or id mismatch.`);
        const eventIntegrity = sha(event.integritySha256, `event ${nextId}.integritySha256`);
        if (digestJson(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'integritySha256'))) !== eventIntegrity)
            problem('EVENT_INTEGRITY', `Event ${nextId} content checksum does not match.`);
        number(event.revision, `event ${nextId}.revision`, { min: 1 });
        if (event.revision !== expectedRevision) problem('EVENT_CHAIN_INVALID', `Expected revision ${expectedRevision}, found ${event.revision} at ${nextId}.`);
        if (event.previousEventId !== null && !UUID_RE.test(event.previousEventId)) problem('INVALID_EVENT', `Event ${nextId}.previousEventId is invalid.`);
        if (event.revision === 1 && event.previousEventId !== null) problem('EVENT_CHAIN_INVALID', 'Revision 1 must have a null previousEventId.');
        text(event.reportedActor, `event ${nextId}.reportedActor`, { max: 256 });
        iso(event.recordedAt, `event ${nextId}.recordedAt`);
        const platform = validateTaskState(event.platformTask, `event ${nextId}.platformTask`, definitions.contracts, { historical: true });
        const maintenance = event.maintenanceTask === undefined ? undefined : validateTaskState(event.maintenanceTask, `event ${nextId}.maintenanceTask`, definitions.contracts, { historical: true });
        for (const state of [platform, ...(maintenance ? [maintenance] : [])]) {
            for (const id of [...state.runIds, ...state.reviewIds]) {
                const record = recordMap.get(id);
                if (!record) problem('MISSING_RECORD_REFERENCE', `${state.taskId} checkpoint references missing record ${id}.`);
                if (record.taskId !== state.taskId) problem('MISMATCHED_RECORD_REFERENCE', `${state.taskId} checkpoint references record ${id} for ${record.taskId}.`);
                if (state.runIds.includes(id) && record.kind !== 'run') problem('MISMATCHED_RECORD_REFERENCE', `${id} is not a run record.`);
                if (state.reviewIds.includes(id) && record.kind !== 'review') problem('MISMATCHED_RECORD_REFERENCE', `${id} is not a review record.`);
            }
        }
        events.push({ event, bytes });
        nextId = event.previousEventId;
        expectedRevision--;
    }
    if (expectedRevision !== 0) problem('EVENT_CHAIN_INVALID', 'Checkpoint chain ended before revision 1.');
    events.reverse();
    return { events, orphanEventIds: [...available].filter(id => !reached.has(id)) };
}

async function currentPointer(root) {
    const pointer = await readJson(root, CURRENT, { optional: true });
    if (!pointer) return { pointer: null, revision: 0, event: null, eventBytes: null };
    exactKeys(pointer, ['schema', 'revision', 'eventId', 'eventSha256'], [], 'current pointer');
    if (pointer.schema !== 'brain.current-pointer.v1') problem('INVALID_CURRENT_POINTER', 'Unsupported current pointer schema.');
    number(pointer.revision, 'current pointer.revision', { min: 1 });
    if (!UUID_RE.test(pointer.eventId)) problem('INVALID_CURRENT_POINTER', 'Current pointer eventId is invalid.');
    sha(pointer.eventSha256, 'current pointer.eventSha256');
    const eventBytes = await safeRead(root, `${EVENTS}/${pointer.eventId}.json`);
    if (digest(eventBytes) !== pointer.eventSha256) problem('CURRENT_EVENT_INTEGRITY', 'Current pointer event digest does not match the immutable event.');
    const event = JSON.parse(eventBytes.toString('utf8'));
    if (event.id !== pointer.eventId || event.revision !== pointer.revision) problem('CURRENT_POINTER_MISMATCH', 'Current pointer revision/event does not match its event.');
    return { pointer, revision: pointer.revision, event, eventBytes };
}

function currentViewText(pointer, event) {
    const lines = [
        '# Current workflow checkpoint',
        '',
        `Revision: ${pointer.revision}  `,
        `Event: ${pointer.eventId}  `,
        `Recorded: ${event.recordedAt}  `,
        `Reported actor: ${event.reportedActor}`,
        '',
        'This generated view summarizes immutable project-local records. Reported run and review fields are not authenticated proof of execution, reviewer identity, model identity, or external acceptance.',
        '',
        '## Mapped platform work',
        '',
        ...renderTask(event.platformTask),
        '',
        '## Maintenance work',
        '',
        ...(event.maintenanceTask ? renderTask(event.maintenanceTask) : ['No separate maintenance task is recorded.']),
        '',
        'Repair this file from the current pointer with `npm run brain -- checkpoint --render`.',
        ''
    ];
    return lines.join('\n');
}

function renderTask(task) {
    const lines = [
        `Task: ${task.taskId}`,
        `Status: ${task.status}`,
        `Candidate: ${task.candidate?.digest ?? 'unbound'}`,
        `Next action: ${task.nextAction}`,
        `Blockers: ${task.blockers.length ? task.blockers.join('; ') : 'none reported'}`,
        `Run records: ${task.runIds.length ? task.runIds.join(', ') : 'none'}`,
        `Review records: ${task.reviewIds.length ? task.reviewIds.join(', ') : 'none'}`,
        `Gates: ${task.gates.length ? task.gates.map(gate => `${gate.id}=${gate.status}`).join(', ') : 'none reported'}`
    ];
    if (task.importProvenance) {
        lines.push(`Imported from: ${task.importProvenance.sourceRef} (${task.importProvenance.originalStatus})`);
        if (task.importProvenance.limitations.length) lines.push(`Import limits: ${task.importProvenance.limitations.join('; ')}`);
    }
    return lines;
}

async function writeView(root, pointer, event) {
    if (!pointer || !event) return false;
    const view = currentViewText(pointer, event);
    const target = assertWithin(root, VIEW);
    const tempRel = `.brain/CURRENT.md.${randomUUID()}.tmp`;
    const temp = assertWithin(root, tempRel);
    await writeFile(temp, view, { flag: 'wx' });
    await rename(temp, target);
    return true;
}

async function acquireLock(root) {
    const lockRel = `${WORKFLOW}/writer.lock`;
    const token = randomUUID();
    const lock = { schema: 'brain.writer-lock.v1', token, owner: `${process.pid}`, acquiredAt: new Date().toISOString() };
    try { await writeFile(assertWithin(root, lockRel), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) {
        if (error.code === 'EEXIST') problem('WRITER_LOCK_HELD', 'A participating Brain writer already holds writer.lock; inspect and reconcile its owner before manual removal. The CLI never reclaims locks by age.');
        throw error;
    }
    return async () => {
        const found = await checkedStat(root, lockRel, { kind: 'file', optional: true });
        if (!found) return;
        const current = await readJson(root, lockRel);
        if (current?.token !== token) problem('WRITER_LOCK_CHANGED', 'writer.lock no longer belongs to this operation; it was left untouched.');
        await unlink(found.absolute);
    };
}

function serialize(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

async function readInputFile(root, inputPath) {
    safeRelative(inputPath, '--input');
    const bytes = await safeRead(root, inputPath);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch (error) { problem('INVALID_JSON', `${inputPath} is not valid JSON: ${error.message}`); }
}

async function captureArtifacts(root, recordId, paths) {
    if (!paths.length) return [];
    const names = new Set();
    const sources = [];
    for (const sourceRef of paths) {
        const name = basename(sourceRef);
        if (!name || names.has(name)) problem('INVALID_ARTIFACT', `Artifact basenames must be unique within one record: ${name}`);
        names.add(name);
        const found = await checkedStat(root, sourceRef, { kind: 'file' });
        if (found.info.size > MAX_ARTIFACT_BYTES)
            problem('INPUT_TOO_LARGE', `${sourceRef} exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit.`);
        sources.push({ sourceRef, name });
    }
    const destDirRel = `${ARTIFACTS}/${recordId}`;
    await ensureDirectory(root, ARTIFACTS);
    await mkdir(assertWithin(root, destDirRel));
    const result = [];
    try {
        for (const { sourceRef, name } of sources) {
            const bytes = await safeRead(root, sourceRef, { maxBytes: MAX_ARTIFACT_BYTES });
            const path = `${destDirRel}/${name}`;
            await writeFile(assertWithin(root, path), bytes, { flag: 'wx' });
            const copied = await safeRead(root, path, { maxBytes: MAX_ARTIFACT_BYTES });
            if (!copied || copied.length !== bytes.length || digest(copied) !== digest(bytes))
                problem('ARTIFACT_INTEGRITY', `Copied evidence failed integrity validation: ${path}`);
            result.push({ sourceRef, path, sha256: digest(bytes), bytes: bytes.length });
        }
        return result;
    } catch (error) {
        await rm(assertWithin(root, destDirRel), { recursive: true, force: true });
        throw error;
    }
}

export async function record(rootInput, inputPath) {
    const root = await rootPath(rootInput);
    const input = validateRecordInput(await readInputFile(root, inputPath));
    const definitions = await loadDefinitions(root);
    const contract = definitions.contracts.get(input.taskId);
    if (!contract) problem('MISSING_CONTRACT', `No contract exists for ${input.taskId}.`);
    const contractBytes = definitions.contractBytes.get(input.taskId);
    const contractDigestValue = digest(contractBytes);
    const currentCandidate = await computeCandidate(root, contract);
    const candidate = input.candidate === undefined || input.candidate === null
        ? currentCandidate
        : validateCandidate(input.candidate, input.candidate.digest === currentCandidate.digest ? contract.allowedPaths : undefined);
    const id = randomUUID();
    let recipe;
    let artifacts;
    if (input.kind === 'run') {
        recipe = definitions.recipes.get(input.recipeId);
        if (!recipe) problem('MISSING_RECIPE', `No recipe exists for ${input.recipeId}.`);
        if (recipe.criterionIds.some(id => !contract.criteria.some(criterion => criterion.id === id)))
            problem('RECIPE_CONTRACT_MISMATCH', `Recipe ${input.recipeId} includes criteria not declared by ${input.taskId}.`);
    } else {
        if (input.implementer !== contract.owners.implementer)
            problem('REVIEW_IMPLEMENTER_MISMATCH', `Review implementer must match the task contract owner ${contract.owners.implementer}.`);
        if (input.independence === 'independent_reported' && input.reviewer === input.implementer)
            problem('REVIEW_NOT_INDEPENDENT', 'An independent_reported review must name a reviewer different from the implementer. This is an attributed claim, not authenticated identity.');
    }
    await ensureDirectory(root, RECORDS);
    artifacts = await captureArtifacts(root, id, input.artifactPaths);
    try {
        const record = input.kind === 'run' ? {
            schema: 'brain.evidence-record.v1', kind: 'run', id, taskId: input.taskId, recipeId: input.recipeId,
            contractDigest: contractDigestValue, recipeDigest: digestJson(recipe), candidate,
            recordedAt: new Date().toISOString(), command: { argv: recipe.argv, cwd: recipe.cwd },
            environment: input.environment, status: input.status, exitCode: input.exitCode,
            ...(input.counts ? { counts: input.counts } : {}), artifacts,
            provenance: input.provenance, limitations: input.limitations
        } : {
            schema: 'brain.evidence-record.v1', kind: 'review', id, taskId: input.taskId,
            contractDigest: contractDigestValue, candidate, recordedAt: new Date().toISOString(),
            reviewer: input.reviewer, implementer: input.implementer, independence: input.independence,
            outcome: input.outcome, scope: input.scope, artifacts, provenance: input.provenance, limitations: input.limitations
        };
        if (input.resolution !== undefined) {
            record.resolution = input.resolution;
            validateResolutions([...(await readAllRecords(root, definitions)), record]);
        }
        if (input.kind === 'review' && contract.reviewRequirement.required && input.independence !== contract.reviewRequirement.independence)
            problem('REVIEW_REQUIREMENT_MISMATCH', `Review independence must be ${contract.reviewRequirement.independence} for ${input.taskId}.`);
        record.integritySha256 = digestJson(record);
        validateEmittedRecord(record, id, definitions);
        const bytes = Buffer.from(serialize(record), 'utf8');
        if (bytes.length > MAX_JSON_BYTES)
            problem('RECORD_TOO_LARGE', `Serialized evidence record exceeds the ${MAX_JSON_BYTES}-byte record limit.`);
        await validateRecordArtifacts(root, record);
        await writeFile(assertWithin(root, `${RECORDS}/${id}.json`), bytes, { flag: 'wx' });
        return { record, recordPath: `${RECORDS}/${id}.json`, contractDigest: contractDigestValue, currentCandidate: currentCandidate.digest, candidateIsCurrent: candidate.digest === currentCandidate.digest };
    } catch (error) {
        if (artifacts.length) await rm(assertWithin(root, `${ARTIFACTS}/${id}`), { recursive: true, force: true });
        throw error;
    }
}

function parseCheckpointInput(input) {
    exactKeys(input, ['schema', 'reportedActor', 'platformTask'], ['maintenanceTask'], 'checkpoint input');
    if (input.schema !== 'brain.checkpoint-input.v1') problem('INVALID_CHECKPOINT', 'Checkpoint input must use brain.checkpoint-input.v1.');
    text(input.reportedActor, 'reportedActor', { max: 256 });
    return input;
}

async function atomicCurrent(root, pointer) {
    const tempRel = `${WORKFLOW}/current.${randomUUID()}.tmp`;
    const temp = assertWithin(root, tempRel);
    await writeFile(temp, serialize(pointer), { flag: 'wx' });
    await rename(temp, assertWithin(root, CURRENT));
}

export async function checkpoint(rootInput, inputPath, expectedRevision) {
    const root = await rootPath(rootInput);
    const release = await acquireLock(root);
    try {
        const definitions = await loadDefinitions(root, { allowBootstrap: expectedRevision === 0 });
        const previous = await currentPointer(root);
        if (expectedRevision !== previous.revision)
            problem('STALE_REVISION', `Expected revision ${expectedRevision}, current revision is ${previous.revision}.`);
        const input = parseCheckpointInput(await readInputFile(root, inputPath));
        const contractPathTask = mappedPlatformContractId(definitions);
        if (!input.platformTask || input.platformTask.taskId !== contractPathTask)
            problem('MAPPED_TASK_MISMATCH', `platformTask.taskId must match the contract mapped from project.current_work (${contractPathTask}).`);
        const platformTask = validateTaskState(input.platformTask, 'platformTask', definitions.contracts);
        const maintenanceTask = input.maintenanceTask ? validateTaskState(input.maintenanceTask, 'maintenanceTask', definitions.contracts) : undefined;
        const records = await readAllRecords(root, definitions);
        const priorEvents = await readEvents(root, definitions, records, previous.pointer);
        const previousEvent = priorEvents.events.at(-1)?.event ?? null;
        const nextStates = [platformTask, ...(maintenanceTask ? [maintenanceTask] : [])];
        checkTransition(previousEvent, nextStates);
        if (platformTask.status === 'IMPLEMENTING' &&
            !(previousEvent?.platformTask?.taskId === platformTask.taskId && previousEvent.platformTask.status === 'IMPLEMENTING')) {
            const readiness = await currentReadiness(root, definitions, previousEvent);
            if (!readiness.readiness.ready)
                problem('EXECUTION_NOT_READY', `Platform implementation admission is blocked: ${readiness.readiness.reasons.map(item => item.code).join(', ')}.`, { executionReadiness: readiness.readiness });
        }
        await verifyImportDigests(root, nextStates, previousEvent);
        const byId = new Map(records.map(record => [record.id, record]));
        for (const state of nextStates) {
            const contract = definitions.contracts.get(state.taskId);
            if (state.status === 'ACCEPTED') {
                if (!contract || contract.authorization.kind !== 'authorized')
                    problem('UNAUTHORIZED_ACCEPTANCE', `${state.taskId} cannot be marked ACCEPTED under ${contract?.authorization.kind ?? 'missing'} authorization.`);
                const fresh = await computeCandidate(root, contract);
                const contractDigestValue = digest(definitions.contractBytes.get(state.taskId));
                if (canonicalJson(state.candidate) !== canonicalJson(fresh)) problem('STALE_ACCEPTANCE', `${state.taskId} acceptance candidate does not match current scoped source.`);
                const assessment = assessEvidence(contract, fresh, contractDigestValue, records, state.runIds, state.reviewIds, definitions.recipes);
                if (assessment.status !== 'QUALIFYING_REPORTED_EVIDENCE')
                    problem('ACCEPTANCE_EVIDENCE_MISSING', `${state.taskId} lacks qualifying reported evidence: ${assessment.reasons.join(', ')}.`);
            }
            for (const id of [...state.runIds, ...state.reviewIds]) {
                const record = byId.get(id);
                if (!record) problem('MISSING_RECORD_REFERENCE', `${state.taskId} references missing record ${id}.`);
                if (record.taskId !== state.taskId) problem('MISMATCHED_RECORD_REFERENCE', `${state.taskId} references record ${id} for ${record.taskId}.`);
                if (state.runIds.includes(id) && record.kind !== 'run') problem('MISMATCHED_RECORD_REFERENCE', `${id} is not a run record.`);
                if (state.reviewIds.includes(id) && record.kind !== 'review') problem('MISMATCHED_RECORD_REFERENCE', `${id} is not a review record.`);
            }
        }
        const id = randomUUID();
        const event = {
            schema: 'brain.checkpoint-event.v1', id, revision: previous.revision + 1,
            previousEventId: previous.pointer?.eventId ?? null, reportedActor: input.reportedActor,
            recordedAt: new Date().toISOString(), platformTask,
            ...(maintenanceTask ? { maintenanceTask } : {})
        };
        event.integritySha256 = digestJson(event);
        const eventBytes = Buffer.from(serialize(event), 'utf8');
        await ensureDirectory(root, EVENTS);
        await writeFile(assertWithin(root, `${EVENTS}/${id}.json`), eventBytes, { flag: 'wx' });
        const pointer = { schema: 'brain.current-pointer.v1', revision: event.revision, eventId: id, eventSha256: digest(eventBytes) };
        await atomicCurrent(root, pointer);
        try { await writeView(root, pointer, event); }
        catch (error) {
            problem('CURRENT_VIEW_STALE', `Checkpoint revision ${pointer.revision} committed, but generated ${VIEW} could not be refreshed. Run checkpoint --render. ${error.message}`, { committed: true, revision: pointer.revision, eventId: id });
        }
        return { pointer, event, viewPath: VIEW, committed: true };
    } finally {
        await release();
    }
}

export async function repairView(rootInput) {
    const root = await rootPath(rootInput);
    const release = await acquireLock(root);
    try {
        const current = await currentPointer(root);
        if (!current.pointer) problem('NO_CURRENT_CHECKPOINT', 'There is no current checkpoint to render.');
        await writeView(root, current.pointer, current.event);
        return { pointer: current.pointer, viewPath: VIEW, repaired: true };
    } finally {
        await release();
    }
}

export async function validate(rootInput) {
    const root = await rootPath(rootInput);
    const errors = [];
    const warnings = [];
    let summary = null;
    let definitions = null;
    let readinessEvent = null;
    try {
        definitions = await loadDefinitions(root);
        for (const contract of definitions.contracts.values()) {
            // A declaration can include future files. Existing ancestors still undergo
            // confinement/type/symlink checks; bound active candidates remain strict below.
            for (const path of contract.allowedPaths) await checkedStat(root, path, { kind: 'file', optional: true });
        }
        const current = await currentPointer(root);
        const records = await readAllRecords(root, definitions);
        const chain = await readEvents(root, definitions, records, current.pointer);
        const last = chain.events.at(-1)?.event ?? null;
        readinessEvent = last ?? current.event ?? null;
        if (last?.id !== current.pointer?.eventId) problem('CURRENT_EVENT_MISMATCH', 'Current pointer is not the final event in its immutable chain.');
        const mappedTaskId = mappedPlatformContractId(definitions);
        if (last && last.platformTask.taskId !== mappedTaskId)
            problem('CURRENT_TASK_MISMATCH', `Current event maps ${last.platformTask.taskId}, while project.current_work maps ${mappedTaskId}; reconcile the current platform state with a new checkpoint.`);
        if (chain.orphanEventIds.length) warnings.push(`Uncommitted event file(s) are not in the current pointer chain and were left untouched: ${chain.orphanEventIds.join(', ')}`);
        if (last) {
            const recordMap = new Map(records.map(record => [record.id, record]));
            for (const state of [last.platformTask, last.maintenanceTask].filter(Boolean)) {
                const activeContract = definitions.contracts.get(state.taskId);
                if (activeContract && (state.candidate !== null || ['REVIEW', 'ACCEPTED'].includes(state.status)))
                    await computeCandidate(root, activeContract);
                if (state.status !== 'ACCEPTED') continue;
                const contract = definitions.contracts.get(state.taskId);
                if (!contract || contract.authorization.kind !== 'authorized')
                    problem('UNAUTHORIZED_ACCEPTANCE', `${state.taskId} cannot be marked ACCEPTED under ${contract?.authorization.kind ?? 'missing'} authorization.`);
                const fresh = await computeCandidate(root, contract);
                if (canonicalJson(state.candidate) !== canonicalJson(fresh))
                    problem('STALE_ACCEPTANCE', `${state.taskId} accepted candidate no longer matches current scoped source.`);
                const assessment = assessEvidence(contract, fresh, digest(definitions.contractBytes.get(state.taskId)), records, state.runIds, state.reviewIds, definitions.recipes);
                if (assessment.status !== 'QUALIFYING_REPORTED_EVIDENCE')
                    problem('ACCEPTANCE_EVIDENCE_MISSING', `${state.taskId} lacks qualifying reported evidence: ${assessment.reasons.join(', ')}.`);
                for (const id of [...state.runIds, ...state.reviewIds]) if (!recordMap.has(id))
                    problem('MISSING_RECORD_REFERENCE', `${state.taskId} references missing record ${id}.`);
            }
        }
        const viewBytes = await safeRead(root, VIEW, { optional: true });
        if (last) {
            const expectedView = currentViewText(current.pointer, last);
            if (!viewBytes || viewBytes.toString('utf8') !== expectedView) problem('CURRENT_VIEW_STALE', `${VIEW} is missing or stale; repair it with checkpoint --render.`);
        } else if (viewBytes) warnings.push(`${VIEW} exists without a current checkpoint.`);
        summary = {
            contractCount: definitions.contracts.size,
            recipeCount: definitions.catalog.recipes.length,
            recordCount: records.length,
            eventCount: chain.events.length,
            revision: current.revision,
            eventId: current.pointer?.eventId ?? null,
            view: last ? 'CURRENT' : 'NOT_INITIALIZED',
            uncommittedEventCount: chain.orphanEventIds.length
        };
    } catch (error) {
        errors.push({ code: error.code ?? 'VALIDATION_ERROR', message: error.message });
    }
    let executionReadiness = null;
    let canonicalProjection = null;
    if (definitions) {
        try {
            const current = await currentReadiness(root, definitions, readinessEvent);
            executionReadiness = current.readiness;
            canonicalProjection = current.projection;
        } catch (error) {
            executionReadiness = assessReadiness({
                atlas: { present: true, error: error.message, structuralStatus: 'INVALID', profile: null, sourceChecks: [] },
                task: { taskId: null, mappedTaskId: null, contractPresent: false, sourceTaskSafe: false, authorization: 'missing' }
            });
        }
    }
    const status = errors.length ? 'INVALID' : 'VALID';
    return {
        status,
        summary,
        errors,
        warnings,
        integrity: { status, errors, warnings, summary },
        executionReadiness,
        canonicalProjection,
        scope: 'project-local record consistency; no execution or approval authentication'
    };
}

export async function preflight(rootInput) {
    const validation = await validate(rootInput);
    const ready = validation.status === 'VALID' && validation.executionReadiness?.ready === true;
    return {
        ...validation,
        readyForImplementation: ready,
        admission: ready ? 'READY' : 'BLOCKED',
        admissionReasons: validation.status !== 'VALID'
            ? [{ code: 'WORKFLOW_INTEGRITY_INVALID', message: 'Repair execution records before starting implementation.' }]
            : validation.executionReadiness?.reasons ?? [{ code: 'READINESS_UNAVAILABLE', message: 'Current execution readiness could not be assessed.' }]
    };
}

export async function context(rootInput, taskId = undefined) {
    const root = await rootPath(rootInput);
    const definitions = await loadDefinitions(root);
    const mappedTaskId = mappedPlatformContractId(definitions);
    const selectedTaskId = taskId ?? mappedTaskId;
    if (!TASK_RE.test(selectedTaskId)) problem('INVALID_TASK_ID', 'context --task must be a valid task ID.');
    const contract = definitions.contracts.get(selectedTaskId);
    const sourceTaskPath = contract?.sourceTaskRef ?? definitions.project.canonical.current_work;
    const sourceTaskBytes = await readJsonlessBytes(root, sourceTaskPath);
    const excerptLimit = 4096;
    const sourceTaskText = sourceTaskBytes.toString('utf8');
    const sourceTask = {
        path: sourceTaskPath,
        excerpt: sourceTaskText.slice(0, excerptLimit),
        totalBytes: sourceTaskBytes.length,
        truncated: sourceTaskBytes.length > excerptLimit
    };
    const contractDigestValue = contract ? digest(definitions.contractBytes.get(selectedTaskId)) : null;
    const current = await currentPointer(root);
    if (current.event) {
        exactKeys(current.event, ['schema', 'id', 'revision', 'previousEventId', 'reportedActor', 'recordedAt', 'platformTask', 'integritySha256'], ['maintenanceTask'], 'current event');
        if (current.event.schema !== 'brain.checkpoint-event.v1' || current.event.id !== current.pointer.eventId || current.event.revision !== current.pointer.revision)
            problem('INVALID_EVENT', 'Current event fields do not match the current pointer.');
        const eventIntegrity = sha(current.event.integritySha256, 'current event.integritySha256');
        if (digestJson(Object.fromEntries(Object.entries(current.event).filter(([key]) => key !== 'integritySha256'))) !== eventIntegrity)
            problem('EVENT_INTEGRITY', 'Current event content checksum does not match.');
        validateTaskState(current.event.platformTask, 'current event.platformTask', definitions.contracts, { historical: true });
        if (current.event.maintenanceTask)
            validateTaskState(current.event.maintenanceTask, 'current event.maintenanceTask', definitions.contracts, { historical: true });
    }
    let taskState = null;
    const recordIds = { runIds: [], reviewIds: [] };
    if (current.event) {
        for (const candidateState of [current.event.platformTask, current.event.maintenanceTask].filter(Boolean)) {
            if (candidateState.taskId === selectedTaskId) {
                taskState = candidateState;
                recordIds.runIds = candidateState.runIds;
                recordIds.reviewIds = candidateState.reviewIds;
                break;
            }
        }
    }
    const currentTasks = current.event ? {
        platformTask: current.event.platformTask,
        maintenanceTask: current.event.maintenanceTask ?? null
    } : null;
    const mappingChanged = Boolean(current.event && current.event.platformTask?.taskId !== mappedTaskId);
    const missingPlannedPaths = [];
    if (contract && (!taskState || (taskState.candidate === null && !['REVIEW', 'ACCEPTED'].includes(taskState.status)))) {
        for (const path of contract.allowedPaths)
            if (!await checkedStat(root, path, { kind: 'file', optional: true })) missingPlannedPaths.push(path);
    }
    const candidate = contract && !missingPlannedPaths.length ? await computeCandidate(root, contract) : null;
    // Inspect the ledger, not just cherry-picked checkpoint references.
    const records = await readAllRecords(root, definitions);
    const evidenceAssessment = contract && candidate && taskState
        ? assessEvidence(contract, candidate, contractDigestValue, records, taskState.runIds, taskState.reviewIds, definitions.recipes)
        : { status: 'NOT_QUALIFIED', reasons: ['no checkpoint state or contract evidence'] };
    if (taskState && candidate && canonicalJson(taskState.candidate) !== canonicalJson(candidate)) {
        evidenceAssessment.status = 'NOT_QUALIFIED';
        evidenceAssessment.reasons.push('checkpoint_candidate_stale');
    }
    if (mappingChanged) {
        evidenceAssessment.status = 'NOT_QUALIFIED';
        evidenceAssessment.reasons.push('current_task_mapping_changed_checkpoint_required');
    }
    const canonicalReadiness = await currentReadiness(root, definitions, current.event);
    return {
        status: 'AVAILABLE',
        project: { name: definitions.project.name, canonical: definitions.project.canonical, commandsFile: definitions.project.commands_file },
        selectedTaskId,
        mappedCurrentTaskId: mappedTaskId,
        mappingChanged,
        sourceTask,
        contract: contract ?? null,
        contractDigest: contractDigestValue,
        candidate,
        missingPlannedPaths,
        checkpoint: current.pointer ? { pointer: current.pointer, taskState, currentTasks } : null,
        records,
        evidenceAssessment,
        executionReadiness: canonicalReadiness.readiness,
        canonicalProjection: canonicalReadiness.projection,
        readinessContext: { task: canonicalReadiness.task },
        limitations: ['Stored execution, provenance, actor, reviewer, and acceptance fields are reported claims; the CLI does not authenticate them or execute recipe argv.']
    };
}

async function readJsonlessBytes(root, rel) {
    const bytes = await safeRead(root, rel);
    if (!bytes) problem('SOURCE_TASK_MISSING', `Mapped source task is missing: ${rel}`);
    return bytes;
}

export async function validateInputForCli(rootInput, inputPath) {
    const root = await rootPath(rootInput);
    return readInputFile(root, inputPath);
}

export const workflowPaths = Object.freeze({ WORKFLOW, PROJECT, CONTRACTS, RECORDS, EVENTS, ARTIFACTS, CURRENT, RECIPES, VIEW });
