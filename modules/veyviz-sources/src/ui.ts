import type { Workspace } from '@quadbridge/contracts';
import { el, button, emptyState, field, heading, section, statistic, formAction } from '@quadbridge/web-shell/dom';
import { FIXTURE_ID, type SourceView } from './protocol.js';

export const workspace: Workspace = { mount(ctx) {
  const canWrite = ctx.permissions.includes('veyviz.sources.write');
  ctx.root.append(heading('Recordings', 'Register the reviewed sample recording and keep its identity scoped to this tenant. Filesystem paths and uploads are not accepted here.'));
  const stats = el('div', 'stat-grid'); ctx.root.append(stats);
  const grid = el('div', 'grid'), setup = section(), list = section(); grid.append(setup, list); ctx.root.append(grid);
  setup.append(el('h3', '', 'Register local fixture'));
  setup.append(el('p', 'small muted', 'Fixture: MIVIA video 0062 · local recorded footage · not a live camera'));
  if (canWrite) {
    const form = el('form'), name = field('Display name', 'name'); name.input.maxLength = 160; name.input.value = 'MIVIA video 0062';
    form.append(name.wrap); formAction(form, 'Register recording', async () => { await ctx.api.post('/api/sources', { fixtureId: FIXTURE_ID, name: name.input.value }); name.input.value = 'MIVIA video 0062'; await refresh(); }, ctx.signal, ctx.notice); setup.append(form);
  } else setup.append(el('p', 'small muted', 'Read-only access. You can inspect registered recordings, but this account cannot register or rename them.'));
  const status = el('p', 'small muted', 'Source registration records an opaque fixture identity. It does not certify commissioning, camera health or occupancy.'); setup.append(status);
  async function refresh() {
    const data = await ctx.api.get('/api/sources') as { items: SourceView[] };
    if (ctx.signal.aborted) return;
    stats.replaceChildren(statistic('Registered sources', data.items.length, 'Current tenant'), statistic('Supported fixture', '1', 'Reviewed local recording profile'));
    list.replaceChildren(el('h3', '', 'Source inventory'));
    if (!data.items.length) { list.append(emptyState('No recording registered', 'Register the admitted local fixture to begin.')); return; }
    for (const source of data.items) {
      const article = el('article', 'list-item'), meta = el('div', 'item-meta', `${source.fixtureId} · version ${source.version}`);
      article.append(meta, el('p', 'small muted', `Registered ${new Date(source.created).toLocaleString()}`));
      if (canWrite) {
        const label = field('Display name', `name-${source.id}`); label.input.value = source.name; label.input.maxLength = 160;
        const rename = button('Save name', () => void ctx.api.post('/api/sources/rename', { sourceId: source.id, name: label.input.value }).then(refresh).catch(error => ctx.notice(error instanceof Error ? error.message : 'Source could not be updated')));
        article.append(label.wrap, rename);
      } else article.append(el('p', 'small muted', `Name: ${source.name}`));
      list.append(article);
    }
  }
  void refresh().catch(error => ctx.notice(error instanceof Error ? error.message : 'Source inventory unavailable'));
  return () => {};
} };
