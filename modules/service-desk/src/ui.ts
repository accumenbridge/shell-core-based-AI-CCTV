import type { Workspace } from '@quadbridge/contracts';
import { el, button, field, heading, section, formAction, statistic, emptyState } from '@quadbridge/web-shell/dom';
export const workspace: Workspace = { mount(ctx) {
        ctx.root.append(heading('Service requests', 'Manage requests in your current tenant. Changes are saved by Service Desk.'));
        const stats = el('div', 'stat-grid');
        ctx.root.append(stats);
        const grid = el('div', 'grid'), create = section(), list = section();
        grid.append(create, list);
        ctx.root.append(grid);
        create.append(el('h3', '', 'Create a request'));
        const form = el('form'), title = field('Title', 'title'), details = field('Details', 'details', true);
        form.append(title.wrap, details.wrap);
        const refresh = async () => {
            const data = await ctx.api.get('/api/requests') as {
                items: {
                    id: string;
                    title: string;
                    details: string;
                    state: string;
                    version: number;
                    source: string | null;
                }[];
            };
            if (ctx.signal.aborted)
                return;
            stats.replaceChildren(statistic('Loaded requests', data.items.length, 'Current response · current tenant'), statistic('Open in this list', data.items.filter(x => x.state === 'OPEN').length, 'Ready for review'), statistic('Closed in this list', data.items.filter(x => x.state !== 'OPEN').length, 'Owner-confirmed state'));
            list.replaceChildren(el('h3', '', 'Requests'), button('Refresh', () => void refresh().catch(e => ctx.notice(e.message)), 'button secondary small'));
            if (!data.items.length)
                list.append(emptyState('No requests in this tenant.', 'Create a request to begin. Only this tenant’s records will appear here.'));
            for (const item of data.items) {
                const node = el('article', 'list-item');
                node.append(el('div', 'item-meta', `${item.state} · revision ${item.version}`), el('h3', '', item.title), el('p', 'muted break', item.details));
                if (item.source)
                    node.append(el('p', 'receipt', `Linked source: ${item.source}`));
                if (item.state === 'OPEN' && ctx.permissions.includes('desk.close'))
                    node.append(button('Close request', () => { void ctx.api.post('/api/requests/close', { id: item.id, expectedVersion: item.version }).then(() => refresh()).catch(e => ctx.notice(e.message)); }, 'button secondary small'));
                list.append(node);
            }
        };
        if (ctx.permissions.includes('desk.create')) {
            formAction(form, 'Create request', async () => { await ctx.api.post('/api/requests', { title: title.input.value, details: details.input.value }); form.reset(); await refresh(); }, ctx.signal, ctx.notice);
            create.append(form);
        }
        else
            create.append(el('p', 'muted', 'Read access only. New requests are not permitted.'));
        void refresh().catch(e => {
            if (!ctx.signal.aborted)
                ctx.notice(e.message);
        });
        return () => { };
    } };
/** Separate named workspace entry; the shell must not substitute `workspace`. */
export const overviewWorkspace: import('@quadbridge/contracts').Workspace = {
    mount(ctx) {
        void import('./ui/overview.js').then(({ renderOverview }) => {
            if (!ctx.signal.aborted)
                return renderOverview(ctx);
        }).catch(error => { if (!ctx.signal.aborted)
            ctx.notice(error instanceof Error ? error.message : 'Overview unavailable'); });
    }
};
