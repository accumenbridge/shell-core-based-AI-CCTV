import type { UiContribution } from '@quadbridge/contracts/ui-contributions';
import { el } from '@quadbridge/web-shell/dom';

interface ReferenceSearchContext {
  root: HTMLElement;
  signal: AbortSignal;
  api: { get(path: string, signal?: AbortSignal): Promise<unknown> };
  notice(message: string): void;
}

/** Shared, read-only indexed search used by the Knowledge workspace and reviewed slots. */
export function mountReferenceSearch(ctx: ReferenceSearchContext, title = 'Search documents') {
  const heading = el('h3', '', title);
  const form = el('form', 'toolbar'), query = el('input'), search = el('button', 'button secondary', 'Search');
  query.setAttribute('aria-label', 'Search documents');
  query.placeholder = 'Search indexed text';
  query.maxLength = 200;
  query.required = true;
  search.type = 'submit';
  form.append(query, search);
  const matches = el('div');
  ctx.root.append(heading, form, matches);
  let generation = 0, active: AbortController | undefined;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (ctx.signal.aborted) return;
    active?.abort();
    const controller = new AbortController(), ownGeneration = ++generation;
    active = controller;
    const abortFromScope = () => controller.abort();
    ctx.signal.addEventListener('abort', abortFromScope, { once: true });
    search.disabled = true;
    matches.replaceChildren(el('p', 'muted', 'Searching indexed documents…'));
    try {
      const data = await ctx.api.get(`/api/documents/search?q=${encodeURIComponent(query.value)}`, controller.signal) as {
        items: { title: string; version: number; excerpt: string }[];
      };
      if (ctx.signal.aborted || controller.signal.aborted || ownGeneration !== generation) return;
      matches.replaceChildren(el('p', 'small muted', 'Search coverage: indexed documents only.'));
      if (!Array.isArray(data.items) || data.items.length === 0) {
        matches.append(el('p', 'muted', 'No indexed matches. This is not proof that no matching document exists.'));
      }
      else {
        for (const item of data.items.slice(0, 25)) {
          if (!item || typeof item.title !== 'string' || typeof item.excerpt !== 'string') continue;
          const node = el('article', 'list-item');
          const version = Number.isSafeInteger(item.version) && item.version >= 1 ? ` · v${item.version}` : '';
          node.append(el('h4', '', `${item.title}${version}`), el('p', 'muted', item.excerpt));
          matches.append(node);
        }
      }
    }
    catch (error) {
      if (!ctx.signal.aborted && !controller.signal.aborted && ownGeneration === generation)
        ctx.notice(error instanceof Error ? error.message : 'Search failed');
    }
    finally {
      ctx.signal.removeEventListener('abort', abortFromScope);
      if (ownGeneration === generation) {
        search.disabled = false;
        active = undefined;
      }
    }
  }, { signal: ctx.signal });
  return () => { generation++; active?.abort(); active = undefined; };
}

export const referenceSearchPanel: UiContribution = {
  mount(ctx) {
    ctx.root.className = 'content workspace-contribution-panel';
    return mountReferenceSearch(ctx, 'Reference search');
  }
};
