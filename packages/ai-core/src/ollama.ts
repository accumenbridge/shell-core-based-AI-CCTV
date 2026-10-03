import { PlatformError } from '@quadbridge/contracts';
import type { EvidenceAnswerInput, GeneratedEvidenceAnswer, GeneratedEvidenceProvider, ModelAnswerIdentity } from './index.js';

const endpoint = 'http://127.0.0.1:21434/api/chat';
const model = 'qwen3:4b';
const maxInputBytes = 24 * 1024;
const maxResponseBytes = 12 * 1024;
const maxOutputBytes = 8 * 1024;
export const OLLAMA_QWEN3_IDENTITY: ModelAnswerIdentity = Object.freeze({ adapter: 'ollama', model: 'qwen3:4b', label: 'Ollama · qwen3:4b' });

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateInput(input: EvidenceAnswerInput): void {
  if (!plainRecord(input) || Object.keys(input).some(key => !['question', 'evidence'].includes(key)) ||
      typeof input.question !== 'string' || !input.question.trim() || Buffer.byteLength(input.question, 'utf8') > 4096 ||
      !Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 5)
    throw new PlatformError('INVALID', 'Invalid bounded local model input');
  let bytes = Buffer.byteLength(input.question, 'utf8');
  const ids = new Set<string>();
  for (const chunk of input.evidence) {
    if (!plainRecord(chunk) || Object.keys(chunk).some(key => !['id', 'text'].includes(key)) ||
        typeof chunk.id !== 'string' || !/^e[0-4]$/.test(chunk.id) || ids.has(chunk.id) ||
        typeof chunk.text !== 'string' || !chunk.text.trim() || Buffer.byteLength(chunk.text, 'utf8') > 4096)
      throw new PlatformError('INVALID', 'Invalid bounded local model evidence');
    ids.add(chunk.id);
    bytes += Buffer.byteLength(chunk.id, 'utf8') + Buffer.byteLength(chunk.text, 'utf8');
  }
  if (bytes > maxInputBytes) throw new PlatformError('INVALID', 'Local model input exceeds its fixed byte bound');
}

function parseGeneratedAnswer(value: unknown): GeneratedEvidenceAnswer {
  if (!plainRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'segments') ||
      !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 5)
    throw new PlatformError('INCOMPATIBLE', 'Local model returned an invalid answer');
  let bytes = 0;
  const segments = value.segments.map(segment => {
    if (!plainRecord(segment) || Object.keys(segment).length !== 2 || !Object.hasOwn(segment, 'text') || !Object.hasOwn(segment, 'evidenceIds') ||
        typeof segment.text !== 'string' || !segment.text.trim() || segment.text.includes('\0') ||
        !Array.isArray(segment.evidenceIds) || segment.evidenceIds.length < 1 || segment.evidenceIds.length > 5 ||
        segment.evidenceIds.some(id => typeof id !== 'string' || !/^e[0-4]$/.test(id)) || new Set(segment.evidenceIds).size !== segment.evidenceIds.length)
      throw new PlatformError('INCOMPATIBLE', 'Local model returned an invalid answer segment');
    bytes += Buffer.byteLength(segment.text, 'utf8');
    if (bytes > maxOutputBytes) throw new PlatformError('INCOMPATIBLE', 'Local model answer exceeds its fixed byte bound');
    return Object.freeze({ text: segment.text, evidenceIds: Object.freeze([...segment.evidenceIds] as string[]) });
  });
  return Object.freeze({ segments: Object.freeze(segments) });
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new PlatformError('UNAVAILABLE', 'Local model returned no response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new PlatformError('INCOMPATIBLE', 'Local model response exceeds its fixed byte bound');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new PlatformError('INCOMPATIBLE', 'Local model returned invalid UTF-8'); }
}

/** Fixed loopback-only Ollama adapter. The only variable is the already-selected caller signal. */
export function createOllamaQwen3Provider(fetchImpl: typeof fetch = fetch): GeneratedEvidenceProvider {
  return async (input, { signal }) => {
    validateInput(input);
    if (signal.aborted) throw new PlatformError('UNAVAILABLE', 'Local model request cancelled');
    const format = {
      type: 'object',
      properties: {
        segments: { type: 'array', minItems: 1, maxItems: 5, items: {
          type: 'object', properties: {
            text: { type: 'string', minLength: 1 },
            evidenceIds: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: input.evidence.map(item => item.id) } }
          }, required: ['text', 'evidenceIds'], additionalProperties: false
        } }
      }, required: ['segments'], additionalProperties: false
    };
    const requestBody = JSON.stringify({ model, stream: false, think: false, format,
      options: { temperature: 0, num_predict: 512 },
      messages: [
        { role: 'system', content: 'Write a concise answer as JSON matching the supplied schema. Use only the supplied evidence. Every answer segment must cite one or more supplied evidence IDs. Do not invent citations, facts, tools, or actions.' },
        { role: 'user', content: JSON.stringify({ question: input.question, evidence: input.evidence }) }
      ] });
    if (Buffer.byteLength(requestBody, 'utf8') > maxInputBytes) throw new PlatformError('INVALID', 'Local model request exceeds its fixed byte bound');
    let response: Response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: requestBody });
    } catch {
      if (signal.aborted) throw new PlatformError('UNAVAILABLE', 'Local model request cancelled');
      throw new PlatformError('UNAVAILABLE', 'The selected local model is unavailable');
    }
    if (!response.ok) throw new PlatformError('UNAVAILABLE', 'The selected local model is unavailable');
    let envelope: unknown;
    try { envelope = JSON.parse(await readBounded(response)); }
    catch (error) {
      if (signal.aborted) throw new PlatformError('UNAVAILABLE', 'Local model request cancelled');
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('INCOMPATIBLE', 'Local model returned an invalid response');
    }
    if (!plainRecord(envelope) || envelope.done !== true || !plainRecord(envelope.message) || typeof envelope.message.content !== 'string')
      throw new PlatformError('INCOMPATIBLE', 'Local model returned an invalid response');
    let generated: unknown;
    try { generated = JSON.parse(envelope.message.content); }
    catch { throw new PlatformError('INCOMPATIBLE', 'Local model returned an invalid structured answer'); }
    const parsed = parseGeneratedAnswer(generated);
    const allowed = new Set(input.evidence.map(item => item.id));
    if (parsed.segments.some(segment => segment.evidenceIds.some(id => !allowed.has(id))))
      throw new PlatformError('INCOMPATIBLE', 'Local model cited evidence outside the supplied excerpts');
    return parsed;
  };
}
