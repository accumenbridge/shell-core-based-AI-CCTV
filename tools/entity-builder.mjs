import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SPEC_LIMIT = 64 * 1024;
const FIELD_ID = /^[a-z][A-Za-z0-9_]{0,31}$/;
const MODULE_ID = /^[a-z][a-z0-9-]{1,48}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RESERVED = new Set(['id', 'tenant', 'version', 'created', 'updated', 'constructor', 'prototype', '__proto__']);
const NEUTRAL_PACKAGES = ['contracts', 'sqlite', 'backend-host', 'web-shell'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value, allowed, label) {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label} shape`);
  return value;
}
function label(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function validateEntitySpec(value) {
  const root = exact(value, ['schema', 'module', 'entity', 'fields'], 'entity specification');
  if (root.schema !== 'quadbridge.entity-spec.v1' || !Array.isArray(root.fields) || root.fields.length < 1 || root.fields.length > 12)
    throw new Error('Unsupported entity specification');
  const module = exact(root.module, ['id', 'version', 'label'], 'module');
  if (typeof module.id !== 'string' || !MODULE_ID.test(module.id) || typeof module.version !== 'string' || !VERSION.test(module.version))
    throw new Error('Invalid generated module identity');
  const normalizedModule = { id: module.id, version: module.version, label: label(module.label, 'module label') };
  const entity = exact(root.entity, ['id', 'label', 'displayField'], 'entity');
  if (typeof entity.id !== 'string' || !MODULE_ID.test(entity.id) || typeof entity.displayField !== 'string' || !FIELD_ID.test(entity.displayField))
    throw new Error('Invalid generated entity identity');
  const normalizedEntity = { id: entity.id, label: label(entity.label, 'entity label'), displayField: entity.displayField };
  const seen = new Set();
  let totalTextMaximum = 0;
  const fields = root.fields.map((raw, index) => {
    const field = exact(raw, ['id', 'label', 'type', 'required', 'default', 'minLength', 'maxLength', 'minimum', 'maximum', 'values'], `field ${index + 1}`);
    if (typeof field.id !== 'string' || !FIELD_ID.test(field.id)) throw new Error(`Invalid field ${index + 1} identifier`);
    const folded = field.id.toLowerCase();
    if (seen.has(folded) || RESERVED.has(folded)) throw new Error(`Duplicate or reserved field identifier: ${field.id}`);
    seen.add(folded);
    if (typeof field.required !== 'boolean') throw new Error(`Invalid requiredness for ${field.id}`);
    if (!['text', 'integer', 'boolean', 'enum'].includes(field.type)) throw new Error(`Unsupported field type for ${field.id}`);
    const result = { id: field.id, label: label(field.label, `${field.id} label`), type: field.type, required: field.required };
    if (field.type === 'text') {
      if (field.minimum !== undefined || field.maximum !== undefined || field.values !== undefined) throw new Error(`Unsupported text constraint for ${field.id}`);
      result.minLength = field.minLength === undefined ? 1 : integer(field.minLength, 1, 4000, `${field.id} minimum length`);
      result.maxLength = integer(field.maxLength, 1, 4000, `${field.id} maximum length`);
      if (result.minLength > result.maxLength) throw new Error(`Invalid text range for ${field.id}`);
      totalTextMaximum += result.maxLength;
      if (Object.hasOwn(field, 'default')) {
        if (typeof field.default !== 'string' || field.default.length > result.maxLength) throw new Error(`Invalid text default for ${field.id}`);
        const normalized = field.default.trim();
        if (!normalized || normalized.length < result.minLength) throw new Error(`Invalid normalized text default for ${field.id}`);
        result.default = normalized;
      }
    } else if (field.type === 'integer') {
      if (field.minLength !== undefined || field.maxLength !== undefined || field.values !== undefined) throw new Error(`Unsupported integer constraint for ${field.id}`);
      result.minimum = field.minimum === undefined ? -1_000_000_000 : integer(field.minimum, -1_000_000_000, 1_000_000_000, `${field.id} minimum`);
      result.maximum = field.maximum === undefined ? 1_000_000_000 : integer(field.maximum, -1_000_000_000, 1_000_000_000, `${field.id} maximum`);
      if (result.minimum > result.maximum) throw new Error(`Invalid integer range for ${field.id}`);
      if (Object.hasOwn(field, 'default')) result.default = integer(field.default, result.minimum, result.maximum, `${field.id} default`);
    } else if (field.type === 'boolean') {
      if (field.minLength !== undefined || field.maxLength !== undefined || field.minimum !== undefined || field.maximum !== undefined || field.values !== undefined)
        throw new Error(`Unsupported boolean constraint for ${field.id}`);
      if (Object.hasOwn(field, 'default')) {
        if (typeof field.default !== 'boolean') throw new Error(`Invalid boolean default for ${field.id}`);
        result.default = field.default;
      }
    } else {
      if (field.minLength !== undefined || field.maxLength !== undefined || field.minimum !== undefined || field.maximum !== undefined)
        throw new Error(`Unsupported enum constraint for ${field.id}`);
      if (!Array.isArray(field.values) || field.values.length < 1 || field.values.length > 16) throw new Error(`Invalid enum values for ${field.id}`);
      const values = field.values.map(item => {
        if (typeof item !== 'string' || !item.trim() || item.trim().length > 80 || item.includes('\0')) throw new Error(`Invalid enum member for ${field.id}`);
        return item.trim();
      });
      if (new Set(values).size !== values.length) throw new Error(`Duplicate enum value for ${field.id}`);
      result.values = values;
      if (Object.hasOwn(field, 'default')) {
        if (typeof field.default !== 'string' || !values.includes(field.default)) throw new Error(`Invalid enum default for ${field.id}`);
        result.default = field.default;
      }
    }
    return result;
  });
  if (totalTextMaximum > 8000) throw new Error('Combined text field limits exceed the entity budget');
  const display = fields.find(field => field.id === normalizedEntity.displayField);
  if (!display || !['text', 'enum'].includes(display.type) || (!display.required && display.default === undefined) ||
      (display.type === 'text' ? display.maxLength > 200 : Math.max(...display.values.map(item => item.length)) > 200))
    throw new Error('Display field must be a bounded, always-present text or enum field');
  return { schema: 'quadbridge.entity-spec.v1', module: normalizedModule, entity: normalizedEntity, fields };
}

const json = value => JSON.stringify(value);
const q = value => `"${value.replaceAll('"', '""')}"`;
const sqlString = value => `'${value.replaceAll("'", "''")}'`;
function fieldType(field) {
  if (field.type === 'integer') return 'number';
  if (field.type === 'boolean') return 'boolean';
  if (field.type === 'enum') return field.values.map(json).join(' | ');
  return 'string';
}
function operationFieldSchema(field) {
  if (field.type === 'integer') return { type: 'integer', minimum: field.minimum, maximum: field.maximum };
  if (field.type === 'boolean') return { type: 'boolean' };
  if (field.type === 'enum') return { type: 'string', minLength: 1, maxLength: Math.max(...field.values.map(item => item.length)), enum: field.values };
  return { type: 'string', minLength: field.minLength, maxLength: field.maxLength };
}
function fieldsSchema(fields, { output = false } = {}) {
  return { type: 'object', properties: Object.fromEntries(fields.map(field => [field.id, operationFieldSchema(field)])),
    required: fields.filter(field => output ? field.required || field.default !== undefined : field.required && field.default === undefined).map(field => field.id), additionalProperties: false };
}
function detailSchema(fields) {
  return { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, version: { type: 'integer', minimum: 1 }, fields: fieldsSchema(fields, { output: true }) },
    required: ['id', 'version', 'fields'], additionalProperties: false };
}
function buildDescriptors(spec) {
  const module = spec.module.id, entity = spec.entity, read = `${module}.read`, write = `${module}.write`;
  const detail = detailSchema(spec.fields), display = spec.fields.find(field => field.id === entity.displayField);
  const rowSummary = { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, version: { type: 'integer', minimum: 1 }, label: operationFieldSchema(display) },
    required: ['id', 'version', 'label'], additionalProperties: false };
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
  return [
    { id: `${module}.${entity.id}.list`, version: 1, title: 'List records', description: `List at most 100 ${entity.label} records in the current tenant.`, permission: read, kind: 'read', inputSchema: empty,
      outputSchema: object({ items: { type: 'array', maxItems: 100, items: rowSummary }, limit: { type: 'integer', minimum: 100 } }, ['items', 'limit']) },
    { id: `${module}.${entity.id}.get`, version: 1, title: 'Read record', description: `Read one ${entity.label} in the current tenant.`, permission: read, kind: 'read', inputSchema: object({ id: { type: 'string', minLength: 1, maxLength: 128 } }, ['id']), outputSchema: detail },
    { id: `${module}.${entity.id}.create`, version: 1, title: 'Create record', description: `Create a normalized ${entity.label} in the current tenant.`, permission: write, kind: 'write', inputSchema: object({ fields: fieldsSchema(spec.fields) }, ['fields']), outputSchema: detail },
    { id: `${module}.${entity.id}.edit`, version: 1, title: 'Edit record', description: `Replace fields on the expected ${entity.label} version.`, permission: write, kind: 'write', inputSchema: object({ id: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 }, fields: fieldsSchema(spec.fields) }, ['id', 'expectedVersion', 'fields']), outputSchema: detail }
  ];
}
function sqlColumn(field) {
  const column = q(field.id), required = field.required || field.default !== undefined;
  let type = field.type === 'integer' || field.type === 'boolean' ? 'INTEGER' : 'TEXT';
  let constraint = required ? ' NOT NULL' : '';
  if (field.type === 'text') constraint += ` CHECK (${column} IS NULL OR (length(${column}) <= ${field.maxLength} AND length(trim(${column})) >= ${field.minLength}))`;
  if (field.type === 'integer') constraint += ` CHECK (${column} IS NULL OR (${column} >= ${field.minimum} AND ${column} <= ${field.maximum}))`;
  if (field.type === 'boolean') constraint += ` CHECK (${column} IS NULL OR ${column} IN (0,1))`;
  if (field.type === 'enum') constraint += ` CHECK (${column} IS NULL OR ${column} IN (${field.values.map(sqlString).join(',')}))`;
  return `${column} ${type}${constraint}`;
}
function normalizationLines(fields) {
  return fields.map(field => {
    const key = json(field.id), local = `candidate_${field.id}`;
    const fallback = field.default === undefined ? 'undefined' : json(field.default);
    const checks = field.type === 'text'
      ? `if (typeof ${local} !== 'string') invalid(${json(`Invalid ${field.label}`)});\n    const normalized_${field.id} = ${local}.trim();\n    if (normalized_${field.id}.length > ${field.maxLength} || normalized_${field.id}.length < ${field.minLength}) invalid(${json(`Invalid ${field.label}`)});\n    ${local} = normalized_${field.id};`
      : field.type === 'integer'
        ? `if (typeof ${local} !== 'number' || !Number.isSafeInteger(${local}) || ${local} < ${field.minimum} || ${local} > ${field.maximum}) invalid(${json(`Invalid ${field.label}`)});`
        : field.type === 'boolean'
          ? `if (typeof ${local} !== 'boolean') invalid(${json(`Invalid ${field.label}`)});`
          : `if (typeof ${local} !== 'string' || !${json(field.values)}.includes(${local})) invalid(${json(`Invalid ${field.label}`)});`;
    return `  let ${local}: unknown = Object.hasOwn(source, ${key}) ? source[${key}] : ${fallback};\n  if (${local} !== undefined) {\n    ${checks.replaceAll('\n', '\n    ')}\n    fields[${key}] = ${local};\n  }${field.required && field.default === undefined ? ` else { invalid(${json(`${field.label} is required`)}); }` : ''}`;
  }).join('\n');
}
function projectLines(fields) {
  return fields.map(field => `  if (fields[${json(field.id)}] !== undefined) values[${json(field.id)}] = fields[${json(field.id)}];`).join('\n');
}
function rowFieldLines(fields) {
  return fields.map(field => {
    const key = json(field.id), value = `row[${key}]`;
    const conversion = field.type === 'boolean' ? `${value} === null ? undefined : ${value} === 1` : `${value} === null ? undefined : ${value} as ${fieldType(field)}`;
    return `        ${key}: ${conversion}`;
  }).join(',\n');
}
function fieldValues(fields, variable = 'fields') {
  return fields.map(field => `${variable}[${json(field.id)}] === undefined ? null : ${field.type === 'boolean' ? `(${variable}[${json(field.id)}] ? 1 : 0)` : `${variable}[${json(field.id)}]`}`).join(', ');
}
function uiField(field) {
  const { id, label, type, required, default: defaultValue, minLength, maxLength, minimum, maximum, values } = field;
  return { id, label, type, required, ...(defaultValue !== undefined ? { default: defaultValue } : {}), ...(minLength !== undefined ? { minLength } : {}), ...(maxLength !== undefined ? { maxLength } : {}), ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}), ...(values !== undefined ? { values } : {}) };
}
async function readTemplates(root) {
  const names = ['entity-backend.ts.txt', 'entity-ui.ts.txt', 'entity.css.txt'];
  const values = {};
  for (const name of names) values[name] = await readFile(join(root, 'templates', name), 'utf8');
  return values;
}
function applyTemplate(template, values) {
  return template.replace(/__([A-Z][A-Z0-9_]*)__/g, (_token, key) => {
    if (!Object.hasOwn(values, key)) throw new Error('Generated template contains an unknown placeholder');
    return values[key];
  });
}
async function physicalDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('Entity generation root must be a physical directory');
}

export async function generateEntity(projectRoot, specPath) {
  const root = resolve(projectRoot);
  await physicalDirectory(root);
  const sourceInfo = await lstat(specPath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Entity specification must be a physical regular file');
  const sourceBytes = await readFile(specPath);
  if (sourceBytes.byteLength > SPEC_LIMIT) throw new Error('Entity specification exceeds 64 KiB');
  const parsed = JSON.parse(sourceBytes.toString('utf8'));
  const spec = validateEntitySpec(parsed);
  const normalizedSpecText = `${JSON.stringify(spec, null, 2)}\n`;
  const fields = spec.fields, moduleId = spec.module.id, entityId = spec.entity.id;
  const templates = await readTemplates(root);
  const packages = {};
  for (const name of NEUTRAL_PACKAGES) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
    if (manifest.name !== `@quadbridge/${name}` || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) throw new Error('Selected neutral package manifest is invalid');
    packages[manifest.name] = manifest.version;
  }
  const descriptors = buildDescriptors(spec);
  const fieldTypeText = `{ ${fields.map(field => `${json(field.id)}${field.required || field.default !== undefined ? '' : '?'}: ${fieldType(field)}`).join('; ')} }`;
  const table = `${entityId}_records`, tableSql = q(table), display = fields.find(field => field.id === spec.entity.displayField);
  const columnDefinitions = fields.map(sqlColumn);
  const migration = `CREATE TABLE ${tableSql} (tenant TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version >= 1),${columnDefinitions.join(',')},PRIMARY KEY(tenant,id));`;
  const backend = applyTemplate(templates['entity-backend.ts.txt'], {
    FIELD_TYPE: fieldTypeText,
    DESCRIPTORS: JSON.stringify(descriptors, null, 2),
    TABLE: json(tableSql),
    DISPLAY_COLUMN: q(display.id),
    FIELD_KEYS: JSON.stringify(fields.map(field => field.id)),
    NORMALIZE_FIELDS: normalizationLines(fields),
    PROJECT_FIELDS: projectLines(fields),
    MIGRATION: json(migration),
    READ_PERMISSION: `${moduleId}.read`,
    WRITE_PERMISSION: `${moduleId}.write`,
    MODULE: moduleId,
    SELECT_COLUMNS: fields.map(field => `${q(field.id)} AS ${q(field.id)}`).join(','),
    ROW_FIELDS: rowFieldLines(fields),
    COLUMN_NAMES: fields.map(field => q(field.id)).join(','),
    INSERT_MARKS: fields.map(() => '?').join(','),
    INSERT_VALUES: fieldValues(fields),
    UPDATE_COLUMNS: fields.map(field => `${q(field.id)}=?`).join(','),
    UPDATE_VALUES: `${fieldValues(fields)},`
  });
  const ui = applyTemplate(templates['entity-ui.ts.txt'], { FIELDS: JSON.stringify(fields.map(uiField), null, 2), ENTITY_LABEL: json(spec.entity.label), MODULE: moduleId, WRITE_PERMISSION: `${moduleId}.write` });
  const moduleManifest = {
    id: moduleId, version: spec.module.version, abi: 'quadbridge.module.v1', dependencies: [], provides: [], requires: [],
    permissions: [`${moduleId}.read`, `${moduleId}.write`], operations: descriptors,
    routes: [
      { method: 'GET', path: `/api/${moduleId}`, permission: `${moduleId}.read`, kind: 'read' },
      { method: 'GET', path: `/api/${moduleId}/record`, permission: `${moduleId}.read`, kind: 'read' },
      { method: 'POST', path: `/api/${moduleId}`, permission: `${moduleId}.write`, kind: 'write' },
      { method: 'POST', path: `/api/${moduleId}/edit`, permission: `${moduleId}.write`, kind: 'write' }
    ],
    workspaces: [{ id: `${moduleId}.records`, label: spec.entity.label, path: `/${moduleId}/records`, permission: `${moduleId}.read`, export: 'workspace' }],
    schema: { current: 1, readMin: 1, readMax: 1 }, background: false, browserAssets: ['ui/entity.css']
  };
  const packageJson = {
    name: `@quadbridge/${moduleId}`, version: spec.module.version, private: true, type: 'module',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './*': { types: './dist/*.d.ts', import: './dist/*.js' } },
    dependencies: Object.fromEntries(NEUTRAL_PACKAGES.map(name => [`@quadbridge/${name}`, packages[`@quadbridge/${name}`]]))
  };
  const tsconfig = {
    extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'dist', tsBuildInfoFile: 'dist/.tsbuildinfo' },
    include: ['src/**/*.ts'], references: NEUTRAL_PACKAGES.map(name => ({ path: `../../packages/${name}` }))
  };
  const generatedReadme = `# ${spec.module.label}\n\nGenerated one-entity module ${moduleId}@${spec.module.version}.\n\nThe adjacent entity specification and generation receipt record the bounded source inputs; they are inert metadata, not runtime authority. Review changes as ordinary module source.\n`;
  const output = new Map([
    ['module.json', `${JSON.stringify(moduleManifest, null, 2)}\n`], ['package.json', `${JSON.stringify(packageJson, null, 2)}\n`],
    ['tsconfig.json', `${JSON.stringify(tsconfig, null, 2)}\n`], ['README.md', generatedReadme], ['entity-spec.json', normalizedSpecText],
    ['src/index.ts', backend], ['src/ui.ts', ui], ['src/ui/entity.css', templates['entity.css.txt']]
  ]);
  const templateHashes = Object.fromEntries(Object.entries(templates).map(([name, value]) => [name, sha256(value)]));
  const generatorHash = sha256(await readFile(fileURLToPath(import.meta.url)));
  const generation = {
    schema: 'quadbridge.entity-generation.v1',
    specSha256: sha256(normalizedSpecText), generatorSha256: generatorHash, templateSha256: templateHashes,
    neutralPackages: packages,
    outputSha256: Object.fromEntries([...output].map(([path, content]) => [path, sha256(content)]).sort(([a], [b]) => a.localeCompare(b)))
  };
  output.set('generation.json', `${JSON.stringify(generation, null, 2)}\n`);

  const modulesRoot = join(root, 'modules');
  await physicalDirectory(modulesRoot);
  const destination = resolve(modulesRoot, moduleId), rel = relative(modulesRoot, destination);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Generated module escaped the modules root');
  try { await lstat(destination); throw new Error('Generated module destination already exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await mkdir(destination);
  try {
    await mkdir(join(destination, 'src'));
    await mkdir(join(destination, 'src', 'ui'));
    for (const [path, content] of output) {
      const target = join(destination, ...path.split('/'));
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    throw new Error(`Entity generation was incomplete under modules/${moduleId}; preserve the directory for inspection`, { cause: error });
  }
  return { moduleId, specSha256: generation.specSha256, outputSha256: generation.outputSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [specPath] = process.argv.slice(2);
  if (!specPath) throw new Error('Use: node tools/entity-builder.mjs <spec-file>');
  const result = await generateEntity(TOOL_ROOT, resolve(specPath));
  console.log(`Created modules/${result.moduleId}; source receipt ${result.specSha256}.`);
}
