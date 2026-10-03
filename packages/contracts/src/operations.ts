import { PlatformError, canonical, type Json, type RequestContext } from './index.js';

/** The intentionally small JSON Schema subset understood by executable operations. */
export type OperationSchema = Readonly<Record<string, unknown>>;

export interface OperationDescriptor {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly permission: string;
  readonly kind: 'read' | 'write';
  readonly inputSchema: OperationSchema;
  readonly outputSchema: OperationSchema;
}

export interface OperationRegistration {
  readonly descriptor: OperationDescriptor;
  handle(context: RequestContext, input: Json, commandId?: string): unknown | Promise<unknown>;
}

export const OPERATION_LIMITS = Object.freeze({
  schemaBytes: 16 * 1024,
  inputBytes: 512 * 1024,
  outputBytes: 128 * 1024,
  depth: 8,
  objectProperties: 32,
  arrayItems: 1024,
  nodes: 4096,
  patternLength: 128
});

const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'maxItems', 'enum']);
const objectPrototype = Object.prototype;

function invalid(message: string): never {
  throw new PlatformError('INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === objectPrototype || proto === null;
}

function ownRecord(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(`Invalid operation ${label}`);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`Unsupported operation ${label} field`);
  return value;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || codePointLength(value) > max || value.includes('\0')) invalid(`Invalid operation ${label}`);
  return value.trim();
}

type PatternAtom =
  | { readonly kind: 'literal'; readonly codePoint: number }
  | { readonly kind: 'class'; readonly ranges: readonly (readonly [number, number])[]; readonly negated: boolean };
type PatternToken = PatternAtom & { readonly count: number };

const escapedPatternLiterals = new Set(Array.from('.^$*+?{}[]()|\\-'));
const unescapedPatternTokens = new Set(Array.from('.^$*+?{}[]()|'));

function readEscapedLiteral(points: readonly string[], index: number, end: number): { point: string; next: number } | undefined {
  if (points[index] !== '\\' || index + 1 >= end) return undefined;
  const point = points[index + 1]!;
  if (!escapedPatternLiterals.has(point) || point === '\0') return undefined;
  return { point, next: index + 2 };
}

function readClassPoint(points: readonly string[], index: number, end: number): { point: number; next: number } | undefined {
  if (index >= end || points[index] === ']') return undefined;
  const escaped = readEscapedLiteral(points, index, end);
  const point = escaped?.point ?? (points[index] === '\\' ? undefined : points[index]);
  if (point === undefined || point === '\0') return undefined;
  return { point: point.codePointAt(0)!, next: escaped?.next ?? index + 1 };
}

/**
 * Parse the deliberately small anchored pattern grammar used by operation schemas.
 * Each atom has an exact repetition count, so matching walks the input once and
 * never invokes the JavaScript regular-expression engine.
 */
function compilePattern(pattern: string): PatternToken[] | undefined {
  const points = Array.from(pattern);
  if (points.length > OPERATION_LIMITS.patternLength || points.length < 2 || points[0] !== '^' || points.at(-1) !== '$') return undefined;
  const end = points.length - 1;
  const tokens: PatternToken[] = [];
  let index = 1, expandedLength = 0;

  while (index < end) {
    let token: PatternAtom;
    if (points[index] === '[') {
      index++;
      const negated = points[index] === '^';
      if (negated) index++;
      const ranges: [number, number][] = [];
      let closed = false;
      while (index < end) {
        if (points[index] === ']') { index++; closed = true; break; }
        const first = readClassPoint(points, index, end);
        if (!first) return undefined;
        index = first.next;
        if (points[index] === '-' && index + 1 < end && points[index + 1] !== ']') {
          const last = readClassPoint(points, index + 1, end);
          if (!last || first.point > last.point) return undefined;
          ranges.push([first.point, last.point]);
          index = last.next;
        } else ranges.push([first.point, first.point]);
      }
      if (!closed || !ranges.length) return undefined;
      ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
      const merged: [number, number][] = [];
      for (const range of ranges) {
        const prior = merged.at(-1);
        if (prior && range[0] <= prior[1] + 1) prior[1] = Math.max(prior[1], range[1]);
        else merged.push(range);
      }
      token = { kind: 'class', ranges: merged, negated };
    } else {
      let point: string | undefined;
      if (points[index] === '\\') {
        const escaped = readEscapedLiteral(points, index, end);
        if (!escaped) return undefined;
        point = escaped.point;
        index = escaped.next;
      } else {
        const current = points[index]!;
        if (unescapedPatternTokens.has(current) || current === '\0') return undefined;
        point = current;
        index++;
      }
      token = { kind: 'literal', codePoint: point.codePointAt(0)! };
    }

    let count = 1;
    if (points[index] === '{') {
      index++;
      const start = index;
      while (index < end && /^[0-9]$/u.test(points[index]!)) index++;
      const digits = points.slice(start, index).join('');
      if (!digits || points[index] !== '}' || (digits.length > 1 && digits.startsWith('0'))) return undefined;
      index++;
      count = Number(digits);
      if (!Number.isSafeInteger(count) || count > OPERATION_LIMITS.inputBytes) return undefined;
    }
    expandedLength += count;
    if (expandedLength > OPERATION_LIMITS.inputBytes) return undefined;
    tokens.push({ ...token, count });
  }
  return tokens;
}

function matchesPattern(pattern: string, value: string): boolean {
  const tokens = compilePattern(pattern);
  if (!tokens) return false;
  const points = Array.from(value);
  const expectedLength = tokens.reduce((length, token) => length + token.count, 0);
  if (points.length !== expectedLength) return false;
  let inputIndex = 0;
  for (const token of tokens) {
    for (let repeat = 0; repeat < token.count; repeat++) {
      const point = points[inputIndex++]!.codePointAt(0)!;
      if (token.kind === 'literal') {
        if (point !== token.codePoint) return false;
        continue;
      }
      let low = 0, high = token.ranges.length - 1, inClass = false;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const [first, last] = token.ranges[middle]!;
        if (point < first) high = middle - 1;
        else if (point > last) low = middle + 1;
        else { inClass = true; break; }
      }
      if (token.negated ? inClass : !inClass) return false;
    }
  }
  return true;
}

function safeJson(value: unknown, label: string, maxBytes: number): Json {
  let nodes = 0;
  const ancestors = new Set<object>();
  const inspect = (item: unknown, depth: number): void => {
    nodes++;
    if (nodes > OPERATION_LIMITS.nodes || depth > OPERATION_LIMITS.depth) invalid(`Operation ${label} is too complex`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') invalid(`Operation ${label} is not JSON`);
    if (ancestors.has(item)) invalid(`Operation ${label} contains a cycle`);
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > OPERATION_LIMITS.arrayItems) invalid(`Operation ${label} array is too large`);
        for (const child of item) inspect(child, depth + 1);
      } else {
        if (!isRecord(item)) invalid(`Operation ${label} must use plain objects`);
        const keys = Object.keys(item);
        if (keys.length > OPERATION_LIMITS.objectProperties) invalid(`Operation ${label} object is too large`);
        for (const key of keys) inspect((item as Record<string, unknown>)[key], depth + 1);
      }
    } finally {
      ancestors.delete(item);
    }
  };
  inspect(value, 0);
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { invalid(`Operation ${label} is not serializable`); }
  if (text === undefined || new TextEncoder().encode(text).byteLength > maxBytes) invalid(`Operation ${label} exceeds its byte limit`);
  try { return JSON.parse(text) as Json; } catch { return invalid(`Operation ${label} is not serializable`); }
}

function assertSchema(schema: unknown, depth = 0): OperationSchema {
  if (depth > OPERATION_LIMITS.depth) invalid('Operation schema is too deep');
  const fields = ownRecord(schema, 'schema', [...schemaKeys]);
  if (Object.keys(fields).length === 0) invalid('Operation schema must constrain a value');
  const type = fields.type;
  if (typeof type !== 'string' || !['object', 'string', 'integer', 'boolean', 'array'].includes(type)) invalid('Unsupported operation schema type');
  if (fields.enum !== undefined) {
    if (!Array.isArray(fields.enum) || fields.enum.length === 0 || fields.enum.length > 32) invalid('Invalid operation enum');
    if (fields.enum.some(value => typeof value === 'string' && value.includes('\0'))) invalid('Invalid operation enum');
    const values = fields.enum.map(value => canonical(safeJson(value, 'enum value', OPERATION_LIMITS.schemaBytes)));
    if (new Set(values).size !== values.length) invalid('Duplicate operation enum value');
  }
  if (type === 'object') {
    const properties = fields.properties;
    if (!isRecord(properties) || Object.keys(properties).length > OPERATION_LIMITS.objectProperties || fields.additionalProperties !== false) invalid('Invalid operation object schema');
    for (const [key, child] of Object.entries(properties)) {
      if (!key || key.length > 128 || key.includes('\0')) invalid('Invalid operation property name');
      assertSchema(child, depth + 1);
    }
    if (fields.required !== undefined) {
      if (!Array.isArray(fields.required) || fields.required.length > Object.keys(properties).length || fields.required.some(item => typeof item !== 'string' || !Object.hasOwn(properties, item)) || new Set(fields.required).size !== fields.required.length) invalid('Invalid operation required list');
    }
  }
  if (type === 'array') {
    if (fields.items === undefined || !Number.isSafeInteger(fields.maxItems) || (fields.maxItems as number) < 0 || (fields.maxItems as number) > OPERATION_LIMITS.arrayItems) invalid('Invalid operation array schema');
    assertSchema(fields.items, depth + 1);
  }
  if (type === 'string') {
    for (const key of ['minLength', 'maxLength']) {
      const bound = fields[key];
      if (bound !== undefined && (!Number.isSafeInteger(bound) || (bound as number) < 0 || (bound as number) > OPERATION_LIMITS.inputBytes)) invalid('Invalid operation string bound');
    }
    if (fields.minLength !== undefined && fields.maxLength !== undefined && (fields.minLength as number) > (fields.maxLength as number)) invalid('Invalid operation string bounds');
    if (fields.pattern !== undefined) {
      if (typeof fields.pattern !== 'string' || !compilePattern(fields.pattern)) invalid('Unsupported operation pattern');
    }
  }
  if (type === 'integer') {
    for (const key of ['minimum', 'maximum']) if (fields[key] !== undefined && !Number.isSafeInteger(fields[key])) invalid('Invalid operation integer bound');
    if (fields.minimum !== undefined && fields.maximum !== undefined && (fields.minimum as number) > (fields.maximum as number)) invalid('Invalid operation integer bounds');
  }
  for (const key of schemaKeys) {
    const applicable = type === 'object' ? ['type', 'properties', 'required', 'additionalProperties', 'enum']
      : type === 'array' ? ['type', 'items', 'maxItems', 'enum']
      : type === 'string' ? ['type', 'minLength', 'maxLength', 'pattern', 'enum']
      : type === 'integer' ? ['type', 'minimum', 'maximum', 'enum'] : ['type', 'enum'];
    if (fields[key] !== undefined && !applicable.includes(key)) invalid(`Operation schema keyword ${key} does not apply to ${String(type)}`);
  }
  const cloned = safeJson(fields, 'schema', OPERATION_LIMITS.schemaBytes) as Record<string, unknown>;
  return deepFreeze(cloned) as OperationSchema;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateOperationDescriptor(value: unknown, moduleId?: string, permissions?: readonly string[]): OperationDescriptor {
  const record = ownRecord(value, 'descriptor', ['id', 'version', 'title', 'description', 'permission', 'kind', 'inputSchema', 'outputSchema']);
  const operationId = boundedText(record.id, 'id', 160);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,5}$/.test(operationId) || (moduleId && !operationId.startsWith(`${moduleId}.`))) invalid('Invalid or unowned operation id');
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1 || (record.version as number) > 65535) invalid('Invalid operation version');
  const title = boundedText(record.title, 'title', 120);
  const description = boundedText(record.description, 'description', 512);
  const permission = boundedText(record.permission, 'permission', 128);
  if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(permission) || (permissions && !permissions.includes(permission))) invalid('Undeclared operation permission');
  if (record.kind !== 'read' && record.kind !== 'write') invalid('Invalid operation kind');
  const kind: OperationDescriptor['kind'] = record.kind;
  const descriptor = {
    id: operationId,
    version: record.version as number,
    title,
    description,
    permission,
    kind,
    inputSchema: assertSchema(record.inputSchema),
    outputSchema: assertSchema(record.outputSchema)
  };
  const encoded = JSON.stringify(descriptor);
  if (new TextEncoder().encode(encoded).byteLength > OPERATION_LIMITS.schemaBytes * 2) invalid('Operation descriptor is too large');
  return deepFreeze(descriptor);
}

function matches(schema: OperationSchema, value: Json, depth = 0): boolean {
  if (depth > OPERATION_LIMITS.depth) return false;
  const fields = schema as Record<string, unknown>;
  if (Array.isArray(fields.enum) && !fields.enum.some(item => canonical(item) === canonical(value))) return false;
  switch (fields.type) {
    case 'object': {
      if (!isRecord(value)) return false;
      const properties = fields.properties as Record<string, OperationSchema>;
      const keys = Object.keys(value);
      if (keys.length > OPERATION_LIMITS.objectProperties || keys.some(key => !Object.hasOwn(properties, key))) return false;
      const required = fields.required as string[] | undefined;
      if (required?.some(key => !Object.hasOwn(value, key))) return false;
      return keys.every(key => matches(properties[key]!, value[key]!, depth + 1));
    }
    case 'string':
      return typeof value === 'string' && !value.includes('\0') && (fields.minLength === undefined || codePointLength(value) >= (fields.minLength as number)) &&
        (fields.maxLength === undefined || codePointLength(value) <= (fields.maxLength as number)) &&
        (fields.pattern === undefined || matchesPattern(fields.pattern as string, value));
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) &&
        (fields.minimum === undefined || value >= (fields.minimum as number)) &&
        (fields.maximum === undefined || value <= (fields.maximum as number));
    case 'boolean': return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value) && value.length <= (fields.maxItems as number) && value.every(item => matches(fields.items as OperationSchema, item, depth + 1));
    default: return false;
  }
}

export function validateOperationValue(value: unknown, schema: OperationSchema, direction: 'input' | 'output'): Json {
  const maxBytes = direction === 'input' ? OPERATION_LIMITS.inputBytes : OPERATION_LIMITS.outputBytes;
  const safe = safeJson(value, direction, maxBytes);
  if (!matches(schema, safe)) invalid(`Operation ${direction} does not match its declared schema`);
  return deepFreeze(safe);
}

export function sameOperationDescriptor(left: unknown, right: unknown): boolean {
  try { return canonical(validateOperationDescriptor(left)) === canonical(validateOperationDescriptor(right)); }
  catch { return false; }
}
