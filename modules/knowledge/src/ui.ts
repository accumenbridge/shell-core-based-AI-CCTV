import type { Workspace } from '@quadbridge/contracts';
import { el, button, field, heading, section, formAction, statistic, emptyState } from '@quadbridge/web-shell/dom';
export const workspace: Workspace = { mount(ctx) {
        ctx.root.append(heading('Knowledge library', 'Save reference text, follow indexing progress and search your tenant’s library.'));
        const stats = el('div', 'stat-grid');
        ctx.root.append(stats);
        const grid = el('div', 'grid'), upload = section(), results = section();
        grid.append(upload, results);
        ctx.root.append(grid);
        upload.append(el('h3', '', 'Add text'));
        const form = el('form'), title = field('Document title', 'title'), body = field('Document text', 'body', true);
        form.append(title.wrap, body.wrap);
        const toolbar = el('form', 'toolbar'), query = el('input');
        query.setAttribute('aria-label', 'Search documents');
        query.placeholder = 'Search indexed text';
        query.required = true;
        const search = el('button', 'button secondary', 'Search');
        search.type = 'submit';
        toolbar.append(query, search);
        results.append(toolbar);
        const matches = el('div'), list = el('div');
        results.append(matches, list);
        const answerPanel = section();
        answerPanel.append(el('h3', '', 'Ask from indexed documents'), el('p', 'small muted', 'Local extractive answer · indexed documents only · no model inference'));
        const answerForm = el('form'), question = el('textarea'), ask = el('button', 'button', 'Answer from sources'), cancelAnswer = el('button', 'button secondary', 'Cancel');
        question.setAttribute('aria-label', 'Question');
        question.maxLength = 1000;
        question.required = true;
        question.rows = 3;
        question.placeholder = 'Ask a question about indexed documents';
        ask.type = 'submit';
        cancelAnswer.type = 'button';
        cancelAnswer.disabled = true;
        answerForm.append(question, ask, cancelAnswer);
        const answerStatus = el('div', 'small muted');
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
            cancelAnswer.disabled = false;
            answerStatus.replaceChildren(el('p', 'muted', 'Checking indexed sources…'));
            try {
                const result = await ctx.api.post('/api/documents/answer', { question: question.value }, undefined, controller.signal) as {
                    label: string; state: string; coverage: string; answer: string;
                    citations: { title: string; version: number; excerpt: string; start: number; end: number }[];
                };
                if (controller.signal.aborted || ownGeneration !== answerGeneration || ctx.signal.aborted) return;
                answerStatus.replaceChildren(el('p', 'eyebrow', result.label));
                answerStatus.append(el('p', 'small muted', 'Coverage: indexed documents only.'));
                if (result.state === 'NO_EVIDENCE') answerStatus.append(el('p', 'muted', 'No indexed evidence matched this question.'));
                else {
                    answerStatus.append(el('p', '', result.answer));
                    for (const citation of result.citations) answerStatus.append(el('blockquote', 'list-item', `${citation.title} · v${citation.version} · characters ${citation.start}–${citation.end}: “${citation.excerpt}”`));
                }
            }
            catch (error) {
                if (!controller.signal.aborted && ownGeneration === answerGeneration && !ctx.signal.aborted)
                    answerStatus.replaceChildren(el('p', 'error', error instanceof Error ? error.message : 'Answer could not be completed'));
            }
            finally {
                if (ownGeneration === answerGeneration) {
                    ask.disabled = false;
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
            cancelAnswer.disabled = true;
            answerStatus.replaceChildren(el('p', 'muted', 'Answer cancelled.'));
        }, { signal: ctx.signal });
        question.addEventListener('input', () => {
            answerGeneration++;
            answerController?.abort();
            answerController = undefined;
            ask.disabled = false;
            cancelAnswer.disabled = true;
            answerStatus.replaceChildren(el('p', 'muted', 'Question changed. Ask again to refresh the cited answer.'));
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
        toolbar.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const data = await ctx.api.get(`/api/documents/search?q=${encodeURIComponent(query.value)}`) as {
                    items: {
                        title: string;
                        excerpt: string;
                    }[];
                    coverage: string;
                };
                if (ctx.signal.aborted)
                    return;
                matches.replaceChildren(el('p', 'small muted', 'Search coverage: indexed documents only.'));
                if (!data.items.length)
                    matches.append(el('p', 'muted', 'No indexed matches. This is not proof that no matching document exists.'));
                for (const match of data.items) {
                    const node = el('article', 'list-item');
                    node.append(el('h3', '', match.title), el('p', 'muted', match.excerpt));
                    matches.append(node);
                }
            }
            catch (e) {
                if (!ctx.signal.aborted)
                    ctx.notice(e instanceof Error ? e.message : 'Search failed');
            }
        }, { signal: ctx.signal });
        const timer = setInterval(() => void refresh().catch(e => {
            if (!ctx.signal.aborted)
                ctx.notice(e.message);
        }), 2000);
        void refresh().catch(e => ctx.notice(e.message));
        return () => { clearInterval(timer); answerGeneration++; answerController?.abort(); };
    } };
