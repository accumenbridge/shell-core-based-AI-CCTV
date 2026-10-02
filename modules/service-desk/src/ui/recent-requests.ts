import type { UiContribution } from '@quadbridge/contracts/ui-contributions';
import { el } from '@quadbridge/web-shell/dom';

export const recentRequestsPanel: UiContribution = {
  mount(ctx) {
    ctx.root.className = 'content workspace-contribution-panel';
    ctx.root.append(el('h3', '', 'Recent requests'));
    ctx.root.append(el('p', 'small muted', 'Up to five requests returned for the current tenant.'));
    const list = el('div');
    ctx.root.append(list);
    let disposed = false;
    void ctx.api.get('/api/requests', ctx.signal).then(value => {
      if (disposed || ctx.signal.aborted) return;
      const items = (value as { items?: unknown })?.items;
      if (!Array.isArray(items) || items.length === 0) {
        list.append(el('p', 'muted', 'No requests in the current tenant.'));
        return;
      }
      for (const item of items.slice(0, 5)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const request = item as { title?: unknown; state?: unknown };
        if (typeof request.title !== 'string' || typeof request.state !== 'string') continue;
        const card = el('article', 'list-item');
        card.append(el('span', request.state === 'OPEN' ? 'tag' : 'tag positive', request.state), el('p', '', request.title));
        list.append(card);
      }
    }).catch(error => {
      if (!disposed && !ctx.signal.aborted)
        ctx.notice(error instanceof Error ? error.message : 'Recent requests are unavailable');
    });
    return () => { disposed = true; };
  }
};
