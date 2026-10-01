import type { WorkspaceContext } from '@quadbridge/contracts';
import { el, statistic, heading, emptyState } from '@quadbridge/web-shell/dom';
/** Separate workspace; current owner data, no second business state. */
export async function renderOverview(ctx: WorkspaceContext) {
    const data = await ctx.api.get('/api/requests') as {items:{id:string;title:string;state:string}[]};
    if(ctx.signal.aborted) return;
    ctx.root.replaceChildren(heading('Request overview', 'The same Service Desk records, arranged for a quick review.'));
    const stats=el('div','stat-grid');
    stats.append(statistic('Loaded requests',data.items.length,'Current tenant and returned list'),statistic('Open',data.items.filter(r=>r.state==='OPEN').length),statistic('Closed',data.items.filter(r=>r.state!=='OPEN').length));
    const list=el('section','request-overview');
    for(const row of data.items) {
        const card=el('article','overview-item');
        card.append(el('span',row.state==='OPEN'?'tag':'tag positive',row.state),el('h3','',row.title),el('p','small muted break',row.id));
        list.append(card);
    }
    if(!data.items.length) list.append(emptyState('No requests in this tenant.','Open Service requests to add one.'));
    ctx.root.append(stats,list);
}
