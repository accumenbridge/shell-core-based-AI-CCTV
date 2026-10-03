import { randomUUID, createHash } from 'node:crypto';
import { SqliteOwner, JobQueue } from '@quadbridge/sqlite';
import { PlatformError, object, text, id, type ModuleManifest, type RequestContext, type JobHandler } from '@quadbridge/contracts';
import type { OperationDescriptor, OperationRegistration } from '@quadbridge/contracts/operations';
import { BoundedProviderExecutor, lexicalTerms, type EvidenceAnswerInput, type EvidenceProvider, type GeneratedAnswerSegment, type ModelAnswerCapability } from '@quadbridge/ai-core';
import type { HostedModule } from '@quadbridge/backend-host';
export interface DocumentRecord {
    id: string;
    tenant: string;
    title: string;
    body: string;
    version: number;
    state: string;
    job_id: string;
    created: number;
}
export interface DocumentQueries {
    get(ctx: RequestContext, documentId: string): DocumentRecord;
    list(ctx: RequestContext): {id:string;title:string;version:number}[];
}
export interface KnowledgeCitation {
    productId: string; instanceId: string; tenantId: string; documentId: string; title: string; version: number;
    bodyDigest: string; start: number; end: number; excerpt: string;
}
export interface ExtractiveKnowledgeAnswer {
    label: 'Local extractive answer'; state: 'ANSWERED' | 'NO_EVIDENCE'; coverage: 'INDEXED_DOCUMENTS_ONLY';
    answer: string; citations: KnowledgeCitation[];
}
export interface NoEvidenceModelAnswer {
    label: 'Local model answer not called'; mode: 'generated'; state: 'NO_EVIDENCE'; coverage: 'INDEXED_DOCUMENTS_ONLY';
    answer: ''; identity: ModelAnswerCapability['identity']; citations: [];
}
export interface GeneratedKnowledgeAnswer {
    label: 'Local model-generated answer'; mode: 'generated'; state: 'ANSWERED'; coverage: 'INDEXED_DOCUMENTS_ONLY';
    answer: string; identity: ModelAnswerCapability['identity']; segments: { text: string; citations: KnowledgeCitation[] }[]; citations: KnowledgeCitation[];
}
export type KnowledgeAnswer = ExtractiveKnowledgeAnswer | NoEvidenceModelAnswer | GeneratedKnowledgeAnswer;
export interface DocumentRetrieval { answer(ctx: RequestContext, question: string): Promise<KnowledgeAnswer>; }
export interface KnowledgeOptions { answerProvider?: EvidenceProvider; modelAnswer?: ModelAnswerCapability }
const localExtractiveProvider: EvidenceProvider = async (input, { signal }) => {
    if (signal.aborted) throw new PlatformError('UNAVAILABLE', 'Answer request cancelled');
    const terms = new Set(lexicalTerms(input.question));
    const selected = input.evidence.map(item => ({ id: item.id, score: item.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => terms.has(term)).length }))
        .filter(item => item.score > 0).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5);
    return { evidenceIds: selected.map(item => item.id) };
};
const bodyDigest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const answerBounds = { question: 1000, records: 5, excerpts: 16 * 1024, output: 8 * 1024 } as const;
export interface KnowledgeModule extends HostedModule {
    queue: JobQueue;
    handlers: JobHandler[];
}

const operationDescriptors: OperationDescriptor[] = [
    { id: 'knowledge.documents.search', version: 1, title: 'Search documents', description: 'Search the current tenant’s indexed Knowledge documents.', permission: 'knowledge.read', kind: 'read',
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false },
        outputSchema: { type: 'object', properties: {
            items: { type: 'array', maxItems: 25, items: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, title: { type: 'string', minLength: 1, maxLength: 200 }, version: { type: 'integer', minimum: 1 }, excerpt: { type: 'string', maxLength: 512 } }, required: ['id', 'title', 'version', 'excerpt'], additionalProperties: false } },
            coverage: { type: 'string', enum: ['INDEXED_DOCUMENTS_ONLY'] }, query: { type: 'string', minLength: 1, maxLength: 200 }
        }, required: ['items', 'coverage'], additionalProperties: false } },
    { id: 'knowledge.documents.get', version: 1, title: 'Get a document', description: 'Read a bounded tenant-owned Knowledge document projection.', permission: 'knowledge.read', kind: 'read',
        inputSchema: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['documentId'], additionalProperties: false },
        outputSchema: { type: 'object', properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 }, title: { type: 'string', minLength: 1, maxLength: 200 }, version: { type: 'integer', minimum: 1 },
            state: { type: 'string', enum: ['PENDING', 'READY'] }, excerpt: { type: 'string', maxLength: 4096 }, truncated: { type: 'boolean' }, bodyDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }
        }, required: ['id', 'title', 'version', 'state', 'excerpt', 'truncated', 'bodyDigest'], additionalProperties: false } },
    { id: 'knowledge.documents.create', version: 1, title: 'Create a document', description: 'Create a tenant-owned Knowledge document and enqueue its index job.', permission: 'knowledge.write', kind: 'write',
        inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 64000 } }, required: ['title', 'body'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, title: { type: 'string', minLength: 1, maxLength: 200 }, version: { type: 'integer', minimum: 1 }, state: { type: 'string', enum: ['PENDING'] }, jobId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id', 'title', 'version', 'state', 'jobId'], additionalProperties: false } }
];

function searchDocuments(store: SqliteOwner, ctx: RequestContext, queryInput: unknown) {
    ctx.assertAllowed('knowledge.read', 'read');
    const raw = text(queryInput, 'query', 200);
    const words = raw.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12);
    if (!words?.length) return { items: [], coverage: 'INDEXED_DOCUMENTS_ONLY' as const };
    const query = words.map(w => `"${w.replaceAll('"', '""')}"`).join(' AND ');
    const rows = store.db.prepare(`SELECT d.id,d.title,d.version,substr(snippet(document_search,3,'','',' … ',24),1,512) AS excerpt
        FROM document_search JOIN documents d ON d.tenant=document_search.tenant AND d.id=document_search.document_id
        WHERE document_search MATCH ? AND document_search.tenant=? AND d.state='READY' ORDER BY rank LIMIT 25`).all(query, ctx.tenantId) as unknown as {id:string;title:string;version:number;excerpt:string}[];
    return { items: rows.map(row => ({ id: row.id, title: row.title, version: row.version, excerpt: row.excerpt.slice(0, 512) })), coverage: 'INDEXED_DOCUMENTS_ONLY' as const, query: raw };
}

function createDocument(store: SqliteOwner, queue: JobQueue, ctx: RequestContext, input: unknown, commandId?: string) {
    ctx.assertAllowed('knowledge.write', 'write');
    const body = object(input, ['title', 'body']);
    const title = text(body.title, 'title', 200), content = text(body.body, 'body', 64000);
    return store.command(ctx, 'knowledge.add', commandId, { title, body: content }, 'knowledge.write', () => {
        const documentId = randomUUID();
        const job = queue.enqueue(ctx, 'knowledge.index.v1', `index.${documentId}.1`, { documentId, version: 1 }, 'knowledge.write');
        store.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)').run(documentId, ctx.tenantId, title, content, 1, 'PENDING', job.id, Date.now());
        return { id: documentId, title, version: 1, state: 'PENDING', jobId: job.id };
    });
}

export function createKnowledge(manifest: ModuleManifest, store: SqliteOwner, options: KnowledgeOptions = {}): KnowledgeModule {
    if (options.answerProvider && options.modelAnswer) throw new PlatformError('INVALID', 'Select only one Knowledge answer provider');
    store.migrate([{ version: 1, sql: `CREATE TABLE documents(id TEXT NOT NULL,tenant TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,job_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(tenant,id)); CREATE VIRTUAL TABLE document_search USING fts5(document_id UNINDEXED,tenant UNINDEXED,title,body);` }], manifest.schema);
    const queue = new JobQueue(store);
    const answerExecutor = new BoundedProviderExecutor(options.modelAnswer ? 'local-inference' : 'extractive');
    const answerProvider = options.answerProvider ?? localExtractiveProvider;
    const retrieval: DocumentRetrieval = { async answer(ctx, question) {
            ctx.assertAllowed('knowledge.read', 'read');
            const query = text(question, 'question', answerBounds.question);
            const terms = lexicalTerms(query);
            if (!terms.length) return options.modelAnswer
                ? { label: 'Local model answer not called', mode: 'generated', state: 'NO_EVIDENCE', coverage: 'INDEXED_DOCUMENTS_ONLY', answer: '', identity: options.modelAnswer.identity, citations: [] as [] }
                : { label: 'Local extractive answer', state: 'NO_EVIDENCE', coverage: 'INDEXED_DOCUMENTS_ONLY', answer: '', citations: [] };
            const match = terms.slice(0, 12).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
            const rows = store.db.prepare(`SELECT d.id,d.title,d.version,d.body FROM document_search s JOIN documents d ON d.tenant=s.tenant AND d.id=s.document_id
                WHERE document_search MATCH ? AND s.tenant=? AND d.state='READY' ORDER BY rank LIMIT 5`).all(match, ctx.tenantId) as unknown as {id:string;title:string;version:number;body:string}[];
            const candidates: { citation: KnowledgeCitation; score: number }[] = [];
            for (const row of rows) {
                const digest = bodyDigest(row.body);
                let best: { citation: KnowledgeCitation; score: number } | undefined;
                const sentence = /[^.!?\n]+(?:[.!?]+|(?=\n)|$)/gu;
                for (const found of row.body.matchAll(sentence)) {
                    const raw = found[0], base = found.index ?? 0;
                    let left = 0, right = raw.length;
                    while (left < right && /\s/u.test(raw[left]!)) left++;
                    while (right > left && /\s/u.test(raw[right - 1]!)) right--;
                    const excerpt = raw.slice(left, right), bytes = Buffer.byteLength(excerpt, 'utf8');
                    if (!excerpt || bytes > 4096) continue;
                    const score = excerpt.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => terms.includes(term)).length;
                    if (!score || (best && (score < best.score || (score === best.score && base + left >= best.citation.start)))) continue;
                    best = { score, citation: { productId: ctx.productId, instanceId: ctx.instanceId, tenantId: ctx.tenantId, documentId: row.id,
                        title: row.title, version: row.version, bodyDigest: digest, start: base + left, end: base + right, excerpt } };
                }
                if (best) candidates.push(best);
            }
            candidates.sort((a,b) => b.score - a.score || a.citation.documentId.localeCompare(b.citation.documentId));
            const bounded: { citation: KnowledgeCitation; id: string }[] = [];
            let excerptBytes = 0;
            for (const item of candidates) {
                const bytes = Buffer.byteLength(item.citation.excerpt, 'utf8');
                if (bounded.length >= answerBounds.records || excerptBytes + bytes > answerBounds.excerpts) continue;
                bounded.push({ citation: item.citation, id: `e${bounded.length}` });
                excerptBytes += bytes;
            }
            if (!bounded.length) return options.modelAnswer
                ? { label: 'Local model answer not called', mode: 'generated', state: 'NO_EVIDENCE', coverage: 'INDEXED_DOCUMENTS_ONLY', answer: '', identity: options.modelAnswer.identity, citations: [] as [] }
                : { label: 'Local extractive answer', state: 'NO_EVIDENCE', coverage: 'INDEXED_DOCUMENTS_ONLY', answer: '', citations: [] };
            const providerInput: EvidenceAnswerInput = Object.freeze({ question: query,
                evidence: Object.freeze(bounded.map(item => Object.freeze({ id: item.id, text: item.citation.excerpt }))) });
            ctx.assertAllowed('knowledge.read', 'read');
            if (options.modelAnswer) {
                const generated = await answerExecutor.run(({ signal }) => options.modelAnswer!.answer(providerInput, { signal }), { signal: ctx.signal });
                ctx.assertAllowed('knowledge.read', 'read');
                if (ctx.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Answer request cancelled');
                if (!generated || !Array.isArray(generated.segments) || generated.segments.length < 1 || generated.segments.length > answerBounds.records)
                    throw new PlatformError('INCOMPATIBLE', 'Answer provider returned an invalid generated answer');
                const citationById = new Map(bounded.map(item => [item.id, item.citation]));
                const referenced = new Set<string>();
                let outputBytes = 0;
                const segments: { text: string; citations: KnowledgeCitation[] }[] = [];
                for (const segment of generated.segments as readonly GeneratedAnswerSegment[]) {
                    if (!segment || typeof segment.text !== 'string' || !segment.text.trim() || segment.text.includes('\0') ||
                        !Array.isArray(segment.evidenceIds) || segment.evidenceIds.length < 1 || segment.evidenceIds.length > answerBounds.records ||
                        new Set(segment.evidenceIds).size !== segment.evidenceIds.length)
                        throw new PlatformError('INCOMPATIBLE', 'Answer provider returned an invalid generated segment');
                    outputBytes += Buffer.byteLength(segment.text, 'utf8') + (segments.length ? 2 : 0);
                    if (outputBytes > answerBounds.output) throw new PlatformError('INCOMPATIBLE', 'Generated answer exceeds its fixed byte bound');
                    const citations = segment.evidenceIds.map(evidenceId => {
                        if (typeof evidenceId !== 'string') throw new PlatformError('INCOMPATIBLE', 'Answer provider returned invalid evidence references');
                        const citation = citationById.get(evidenceId);
                        if (!citation) throw new PlatformError('INCOMPATIBLE', 'Answer provider selected unknown evidence');
                        referenced.add(evidenceId);
                        return citation;
                    });
                    segments.push({ text: segment.text, citations });
                }
                if (!segments.length || !referenced.size) throw new PlatformError('INCOMPATIBLE', 'Generated answer must cite captured evidence');
                const citations: KnowledgeCitation[] = [];
                for (const evidenceId of referenced) {
                    const citation = citationById.get(evidenceId)!;
                    ctx.assertAllowed('knowledge.read', 'read');
                    const current = store.db.prepare("SELECT title,version,body FROM documents WHERE tenant=? AND id=? AND state='READY'").get(ctx.tenantId, citation.documentId) as {title:string;version:number;body:string} | undefined;
                    if (!current || current.title !== citation.title || current.version !== citation.version || bodyDigest(current.body) !== citation.bodyDigest ||
                        current.body.slice(citation.start, citation.end) !== citation.excerpt)
                        throw new PlatformError('CONFLICT', 'Indexed source changed while preparing the answer');
                    citations.push(citation);
                }
                ctx.assertAllowed('knowledge.read', 'read');
                if (ctx.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Answer request cancelled');
                return { label: 'Local model-generated answer', mode: 'generated', state: 'ANSWERED', coverage: 'INDEXED_DOCUMENTS_ONLY',
                    answer: segments.map(segment => segment.text).join('\n\n'), identity: options.modelAnswer.identity, segments, citations };
            }
            const selection = await answerExecutor.run(signal => answerProvider(providerInput, signal), { signal: ctx.signal, timeoutMs: 5000 });
            ctx.assertAllowed('knowledge.read', 'read');
            if (ctx.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Answer request cancelled');
            if (!selection || !Array.isArray(selection.evidenceIds) || selection.evidenceIds.length > answerBounds.records ||
                selection.evidenceIds.some(id => typeof id !== 'string') || new Set(selection.evidenceIds).size !== selection.evidenceIds.length)
                throw new PlatformError('INCOMPATIBLE', 'Answer provider returned an invalid selection');
            const selected = selection.evidenceIds.map(id => bounded.find(item => item.id === id));
            if (selected.some(item => !item)) throw new PlatformError('INCOMPATIBLE', 'Answer provider selected unknown evidence');
            const citations: KnowledgeCitation[] = [];
            let answer = '';
            for (const item of selected as { citation: KnowledgeCitation; id: string }[]) {
                ctx.assertAllowed('knowledge.read', 'read');
                const current = store.db.prepare("SELECT title,version,body FROM documents WHERE tenant=? AND id=? AND state='READY'").get(ctx.tenantId, item.citation.documentId) as {title:string;version:number;body:string} | undefined;
                if (!current || current.title !== item.citation.title || current.version !== item.citation.version || bodyDigest(current.body) !== item.citation.bodyDigest ||
                    current.body.slice(item.citation.start, item.citation.end) !== item.citation.excerpt)
                    throw new PlatformError('CONFLICT', 'Indexed source changed while preparing the answer');
                const next = answer ? `${answer}\n\n${item.citation.excerpt}` : item.citation.excerpt;
                if (Buffer.byteLength(next, 'utf8') > answerBounds.output) continue;
                answer = next; citations.push(item.citation);
            }
            ctx.assertAllowed('knowledge.read', 'read');
            if (ctx.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Answer request cancelled');
            return { label: 'Local extractive answer', state: citations.length ? 'ANSWERED' : 'NO_EVIDENCE', coverage: 'INDEXED_DOCUMENTS_ONLY', answer, citations };
        } };
    const queries: DocumentQueries = { list(ctx) {
            ctx.assertAllowed('knowledge.read','read');
            return store.db.prepare('SELECT id,title,version FROM documents WHERE tenant=? ORDER BY created DESC,id LIMIT 100').all(ctx.tenantId) as unknown as {id:string;title:string;version:number}[];
        }, get(ctx, documentId) {
            ctx.assertAllowed('knowledge.read', 'read');
            const row = store.db.prepare('SELECT * FROM documents WHERE tenant=? AND id=?').get(ctx.tenantId, documentId) as unknown as DocumentRecord | undefined;
            if (!row)
                throw new PlatformError('NOT_FOUND', 'Document not found');
            return row;
        } };
    const readProjection = (ctx: RequestContext, documentId: unknown) => {
        ctx.assertAllowed('knowledge.read', 'read');
        const record = queries.get(ctx, id(documentId));
        const excerpt = record.body.slice(0, 4096);
        return { id: record.id, title: record.title, version: record.version, state: record.state, excerpt, truncated: record.body.length > excerpt.length, bodyDigest: bodyDigest(record.body) };
    };
    const handlers: JobHandler[] = [{ kind: 'knowledge.index.v1', async prepare(payload, ctx) {
                const b = object(payload, ['documentId', 'version']);
                const row = store.db.prepare('SELECT * FROM documents WHERE tenant=? AND id=?').get(ctx.tenantId, id(b.documentId)) as unknown as DocumentRecord | undefined;
                if (!row)
                    throw new PlatformError('NOT_FOUND', 'Document not found');
                if (row.version !== b.version)
                    throw new PlatformError('CONFLICT', 'Document version changed');
                if (ctx.signal.aborted)
                    throw new PlatformError('UNAVAILABLE', 'Attempt interrupted');
                return { commit() {
                        const current = store.db.prepare('SELECT version FROM documents WHERE tenant=? AND id=?').get(ctx.tenantId, row.id) as {
                            version: number;
                        } | undefined;
                        if (current?.version !== row.version)
                            throw new PlatformError('CONFLICT', 'Document changed before index commit');
                        store.db.prepare('DELETE FROM document_search WHERE tenant=? AND document_id=?').run(ctx.tenantId, row.id);
                        store.db.prepare('INSERT INTO document_search(document_id,tenant,title,body) VALUES(?,?,?,?)').run(row.id, ctx.tenantId, row.title, row.body);
                        store.db.prepare(`UPDATE documents SET state='READY' WHERE tenant=? AND id=?`).run(ctx.tenantId, row.id);
                        return { documentId: row.id, version: row.version, index: 'sqlite-fts5' };
                    } };
            } }];
    const operations: OperationRegistration[] = [
        { descriptor: operationDescriptors[0]!, handle(ctx, input) { const body = object(input, ['query']); return searchDocuments(store, ctx, body.query); } },
        { descriptor: operationDescriptors[1]!, handle(ctx, input) { const body = object(input, ['documentId']); return readProjection(ctx, body.documentId); } },
        { descriptor: operationDescriptors[2]!, handle(ctx, input, commandId) { return createDocument(store, queue, ctx, input, commandId); } }
    ];
    return { manifest, services: { 'knowledge.document.read.v1': queries, 'knowledge.document.retrieve.v1': retrieval }, queue, handlers, operations, routes: [
            { method: 'GET', path: '/api/documents', permission: 'knowledge.read', kind: 'read', handle(ctx) { return { items: (store.db.prepare('SELECT id,title,version,state,job_id,created FROM documents WHERE tenant=? ORDER BY created DESC,id LIMIT 100').all(ctx.tenantId) as unknown as Partial<DocumentRecord>[]).map(d => ({ ...d, indexJob: queue.publicGet(ctx, d.job_id!) })), limit: 100 }; } },
            { method: 'GET', path: '/api/documents/search', permission: 'knowledge.read', kind: 'read', handle(ctx, _b, q) { return searchDocuments(store, ctx, q.get('q')); } },
            { method: 'POST', path: '/api/documents/answer', permission: 'knowledge.read', kind: 'read', handle(ctx, input) {
                    const b = object(input, ['question']);
                    return retrieval.answer(ctx, text(b.question, 'question', answerBounds.question));
                } },
            { method: 'POST', path: '/api/documents', permission: 'knowledge.write', kind: 'write', handle(ctx, input, _q, key) { return createDocument(store, queue, ctx, input, key); } },
            { method: 'POST', path: '/api/documents/cancel-index', permission: 'knowledge.write', kind: 'write', handle(ctx, input, _q, key) { const b = object(input, ['documentId']); const documentId = id(b.documentId); const record = queries.get(ctx, documentId); return store.command(ctx, 'knowledge.cancel-index', key, { documentId }, 'knowledge.write', () => ({ state: queue.cancel(ctx, record.job_id), jobId: record.job_id })); } }
        ], close: () => store.close() };
}
export function register(env: import('@quadbridge/backend-host').ModuleEnvironment) { return createKnowledge(env.manifest, new SqliteOwner(env.dataPath, env.manifest.id), { modelAnswer: env.modelAnswer }); }
