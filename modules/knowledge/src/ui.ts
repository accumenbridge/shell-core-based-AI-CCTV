import type { Workspace } from '@quadbridge/contracts';
import { actionButton, el, fieldControl, heading, section, formAction, statistic, emptyState, statusNotice } from '@quadbridge/ui/components';
import { mountReferenceSearch } from './ui/reference-search.js';
export { referenceSearchPanel } from './ui/reference-search.js';
export const workspace: Workspace = { mount(ctx) {
        ctx.root.setAttribute('data-knowledge-module', '');
        ctx.root.append(heading('Knowledge library', 'Save reference text, follow indexing progress and search your tenant’s library.'));
        const stats = el('div', 'stat-grid');
        ctx.root.append(stats);
        const grid = el('div', 'grid'), upload = section(), results = section();
        grid.append(upload, results);
        ctx.root.append(grid);
        upload.append(el('h3', '', 'Add text'));
        const form = el('form'), title = fieldControl('Document title', el('input'), { required: true, maxLength: 200, help: 'Use the title readers will recognize in search results.' }), body = fieldControl('Document text', el('textarea'), { required: true, maxLength: 64000, help: 'Indexing uses the text saved to this tenant’s Knowledge library.' });
        title.input.name = 'title'; body.input.name = 'body';
        form.append(title.wrap, body.wrap);
        const list = el('div');
        const disposeSearch = mountReferenceSearch({ root: results, signal: ctx.signal, api: ctx.api, notice: ctx.notice });
        results.append(list);
        const answerPanel = section();
        answerPanel.append(el('h3', '', 'Ask from indexed documents'), el('p', 'small muted', 'Answers use indexed tenant documents. Local model inference is an explicit server-side option.'));
        const answerForm = el('form'), questionField = fieldControl('Question', el('textarea'), { required: true, maxLength: 1000, rows: 3, placeholder: 'Ask a question about indexed documents', help: 'Answers use indexed tenant documents and return source citations.' }), question = questionField.input;
        const ask = actionButton('Answer from sources', () => {}), cancelAnswer = actionButton('Cancel', () => {}, { variant: 'secondary', disabled: true });
        ask.type = 'submit';
        answerForm.append(questionField.wrap, ask, cancelAnswer);
        const answerStatus = el('div', 'qb-answer-status');
        answerStatus.setAttribute('aria-live', 'polite');
        answerPanel.append(answerForm, answerStatus);
        results.append(answerPanel);
        let answerController: AbortController | undefined, answerGeneration = 0;
        answerForm.addEventListener('submit', async event => {
            event.preventDefault();
            answerController?.abort();
            const ownGeneration = ++answerGeneration, controller = new AbortController();
            answerController = controller;
            ask.disabled = true;
            ask.setAttribute('aria-busy', 'true');
            cancelAnswer.disabled = false;
            answerStatus.replaceChildren(statusNotice('pending', 'Checking indexed sources…'));
            try {
                const result = await ctx.api.post('/api/documents/answer', { question: question.value }, undefined, controller.signal) as {
                    label: string; mode?: string; state: string; coverage: string; answer: string;
                    identity?: { label: string };
                    citations: { title: string; version: number; excerpt: string; start: number; end: number }[];
                    segments?: { text: string; citations: { title: string; version: number; excerpt: string; start: number; end: number }[] }[];
                };
                if (controller.signal.aborted || ownGeneration !== answerGeneration || ctx.signal.aborted) return;
                answerStatus.replaceChildren(el('p', 'eyebrow', result.label));
                answerStatus.append(statusNotice('info', 'Coverage: indexed documents only.'));
                if (result.mode === 'generated' && result.identity?.label)
                    answerStatus.append(el('p', 'small muted', `${result.state === 'ANSWERED' ? 'Model' : 'Selected model'}: ${result.identity.label}`));
                if (result.state === 'NO_EVIDENCE') answerStatus.append(statusNotice('empty', 'No indexed evidence matched this question.'));
                else if (result.mode === 'generated' && result.segments) {
                    for (const segment of result.segments) {
                        answerStatus.append(el('p', 'answer-segment', segment.text));
                        for (const citation of segment.citations)
                            answerStatus.append(el('blockquote', 'list-item', `${citation.title} · v${citation.version} · characters ${citation.start}–${citation.end}: “${citation.excerpt}”`));
                    }
                }
                else {
                    answerStatus.append(el('p', '', result.answer));
                    for (const citation of result.citations) answerStatus.append(el('blockquote', 'list-item', `${citation.title} · v${citation.version} · characters ${citation.start}–${citation.end}: “${citation.excerpt}”`));
                }
            }
            catch (error) {
                if (!controller.signal.aborted && ownGeneration === answerGeneration && !ctx.signal.aborted)
                    answerStatus.replaceChildren(statusNotice('unknown', error instanceof Error ? error.message : 'The answer could not be confirmed.'));
            }
            finally {
                if (ownGeneration === answerGeneration) {
                    ask.disabled = false;
                    ask.removeAttribute('aria-busy');
                    cancelAnswer.disabled = true;
                    answerController = undefined;
                }
            }
        }, { signal: ctx.signal });
        cancelAnswer.addEventListener('click', () => {
            answerGeneration++;
            answerController?.abort();
            answerController = undefined;
            ask.disabled = false;
            ask.removeAttribute('aria-busy');
            cancelAnswer.disabled = true;
            answerStatus.replaceChildren(statusNotice('info', 'Answer cancelled.'));
        }, { signal: ctx.signal });
        question.addEventListener('input', () => {
            answerGeneration++;
            answerController?.abort();
            answerController = undefined;
            ask.disabled = false;
            ask.removeAttribute('aria-busy');
            cancelAnswer.disabled = true;
            answerStatus.replaceChildren(statusNotice('info', 'Question changed. Ask again to refresh the cited answer.'));
        }, { signal: ctx.signal });
        async function refresh() {
            const data = await ctx.api.get('/api/documents') as {
                items: {
                    id: string;
                    title: string;
                    state: string;
                    indexJob: {
                        state: string;
                    };
                }[];
            };
            if (ctx.signal.aborted)
                return;
            stats.replaceChildren(statistic('Loaded documents', data.items.length, 'Current response · current tenant'), statistic('Ready in this list', data.items.filter(x => x.state === 'READY').length, 'Available to full-text search'), statistic('Other states', data.items.filter(x => x.state !== 'READY').length, 'See each document’s worker state'));
            list.replaceChildren(el('h3', '', 'Documents'));
            if (!data.items.length)
                list.append(emptyState('No documents in this tenant.', 'Add a text document. Its indexing job runs outside this screen.'));
            for (const item of data.items) {
                const node = el('article', 'list-item');
                node.append(el('div', 'item-meta', `${item.state} · worker ${item.indexJob.state}`), el('h3', '', item.title), el('p', 'receipt', item.id));
                list.append(node);
            }
        }
        if (ctx.permissions.includes('knowledge.write')) {
            formAction(form, 'Save and index', async () => { await ctx.api.post('/api/documents', { title: title.input.value, body: body.input.value }); form.reset(); await refresh(); }, ctx.signal, ctx.notice);
            upload.append(form);
        }
        else
            upload.append(el('p', 'muted', 'Read access only.'));
        const timer = setInterval(() => void refresh().catch(e => {
            if (!ctx.signal.aborted)
                ctx.notice(e.message);
        }), 2000);
        void refresh().catch(e => ctx.notice(e.message));
        return () => { clearInterval(timer); answerGeneration++; answerController?.abort(); disposeSearch(); };
    } };
