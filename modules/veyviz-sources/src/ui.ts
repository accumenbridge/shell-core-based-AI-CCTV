import type { Workspace } from '@quadbridge/contracts';
import { el, field } from '@quadbridge/web-shell/dom';
import { FIXTURE_ID, type SourceView } from './protocol.js';

export const workspace: Workspace = { mount(ctx) {
  const canWrite = ctx.permissions.includes('veyviz.sources.write');
  const page = el('section', 'veyviz-sources'), header = el('header', 'vv-library-heading'), title = el('div');
  title.append(el('h1', '', 'Recordings'),
    el('p', 'vv-library-intro', 'Your team’s registered recording references.'));
  const count = el('span', 'vv-library-count', 'Loading recordings');
  header.append(title, count); page.append(header);
  const feedback = el('p', 'vv-library-feedback');
  feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  let closed = false, loaded = false, loading = false, registering = false;
  let registration: { name: string; key: string } | undefined;
  const rows = new Map<string, HTMLElement>();
  const records = new Map<string, SourceView>();
  const active = () => !closed && !ctx.signal.aborted;
  const message = (text: string, error = false) => {
    if (!active()) return;
    feedback.textContent = text; feedback.classList.toggle('is-error', error); feedback.hidden = !text;
  };
  const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
  const add = el('details', 'vv-library-add'), addSummary = el('summary'), addIcon = el('span', 'vv-add-icon', '+');
  addIcon.setAttribute('aria-hidden', 'true');
  addSummary.append(addIcon, el('span', 'vv-add-label', 'Add sample recording'), el('span', 'vv-add-hint', 'Local MIVIA profile'));
  const addContent = el('div', 'vv-library-add-content'), description = el('div', 'vv-library-add-description');
  description.append(el('h2', '', 'Register the supported sample'),
    el('p', '', 'This workspace supports the installed MIVIA 0062 recording. Give it a name to add it to your library.'),
    el('p', 'vv-field-note', 'Each registration refers to the same sample. This does not upload a new video.'));
  const form = el('form', 'vv-library-add-form'), name = field('Recording name', 'recording-name');
  name.input.maxLength = 160; name.input.value = 'MIVIA video 0062'; name.input.setAttribute('autocomplete', 'off');
  const register = el('button', 'button', 'Add to library'); register.type = 'submit'; register.disabled = true;
  form.append(name.wrap, register); addContent.append(description, form); add.append(addSummary, addContent);
  if (canWrite) page.append(add);
  else page.append(el('p', 'vv-library-readonly', 'Read-only access · You can view the recordings available in this workspace.'));
  page.append(feedback);
  const toolbar = el('div', 'vv-library-toolbar'), searchLabel = el('label', 'vv-library-search'), search = el('input');
  searchLabel.append(el('span', 'vv-sr-only', 'Search recording names or IDs'));
  search.type = 'search'; search.placeholder = 'Search recording names or IDs'; search.maxLength = 160; searchLabel.append(search);
  const filterLabel = el('label', 'vv-library-filter'), filter = el('select');
  filterLabel.append(el('span', 'vv-sr-only', 'Filter recordings'));
  for (const [value, label] of [['all', 'All recordings'], ['renamed', 'Renamed recordings']] as const) { const option = el('option', '', label); option.value = value; filter.append(option); }
  filterLabel.append(filter);
  const sortLabel = el('label', 'vv-library-filter'), sort = el('select');
  sortLabel.append(el('span', 'vv-sr-only', 'Sort recordings'));
  for (const [value, label] of [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A–Z']] as const) { const option = el('option', '', label); option.value = value; sort.append(option); }
  sortLabel.append(sort); toolbar.append(searchLabel, filterLabel, sortLabel); page.append(toolbar);
  page.append(el('p', 'vv-library-scope', 'Search and filters apply to the latest 100 registrations returned for this tenant.'));
  const library = el('section', 'vv-recording-library'); library.setAttribute('aria-label', 'Registered recordings');
  const libraryHeader = el('div', 'vv-library-list-heading'), resultCount = el('h2', '', 'Recording library');
  resultCount.setAttribute('role', 'status'); resultCount.setAttribute('aria-live', 'polite');
  libraryHeader.append(resultCount, el('span', 'vv-recorded-label', 'RECORDED MEDIA'));
  const list = el('div', 'vv-recording-list'), placeholder = el('div', 'vv-library-empty');
  placeholder.append(el('p', '', 'Loading your recordings…'));
  library.append(libraryHeader, list, placeholder); page.append(library); ctx.root.append(page);

  function updateCount() { count.textContent = `${rows.size} ${rows.size === 1 ? 'recording' : 'recordings'}${rows.size >= 100 ? ' shown' : ''}`; }
  function applyFilters() {
    if (!loaded) return;
    const query = search.value.trim().toLocaleLowerCase(ctx.locale);
    const ordered = [...records.values()].sort((a, b) => sort.value === 'name'
      ? a.name.localeCompare(b.name, ctx.locale) || a.id.localeCompare(b.id)
      : (sort.value === 'oldest' ? 1 : -1) * (a.created - b.created) || a.id.localeCompare(b.id));
    let visible = 0;
    for (const source of ordered) {
      const row = rows.get(source.id)!;
      row.hidden = !(source.name.toLocaleLowerCase(ctx.locale).includes(query) || source.id.toLowerCase().includes(query)) || (filter.value === 'renamed' && source.version <= 1);
      if (!row.hidden) visible++;
      list.append(row);
    }
    resultCount.textContent = `${visible} ${visible === 1 ? 'recording' : 'recordings'}${visible !== rows.size ? ` of ${rows.size}` : ''}`;
    if (!rows.size) { showEmpty(); return; }
    placeholder.hidden = visible > 0;
    if (visible) return;
    const clear = el('button', 'button secondary', 'Clear filters'); clear.type = 'button';
    clear.addEventListener('click', () => { search.value = ''; filter.value = 'all'; applyFilters(); search.focus(); }, { signal: ctx.signal });
    placeholder.replaceChildren(el('h3', '', 'No recordings match your filters'), el('p', '', 'Try another name or source ID, or remove the renamed filter.'), clear);
  }
  for (const [control, event] of [[search, 'input'], [filter, 'change'], [sort, 'change']] as const) control.addEventListener(event, applyFilters, { signal: ctx.signal });
  function updateRegister() {
    register.disabled = registering || !loaded || !name.input.value.trim();
    register.textContent = registering ? 'Adding recording…' : 'Add to library';
    name.input.disabled = registering; form.setAttribute('aria-busy', String(registering));
  }
  function showEmpty() {
    placeholder.replaceChildren();
    const symbol = el('div', 'vv-library-empty-symbol'); symbol.setAttribute('aria-hidden', 'true');
    placeholder.append(symbol, el('h3', '', 'Your recording library starts here'),
      el('p', '', canWrite ? 'Add the supported local sample and give it a name your team will recognize.' : 'No recordings have been registered for this workspace yet.'));
    if (canWrite) {
      const first = el('button', 'button secondary', 'Add sample recording'); first.type = 'button';
      first.addEventListener('click', () => { if (active()) { add.open = true; name.input.focus(); } }, { signal: ctx.signal });
      placeholder.append(first);
    }
    placeholder.hidden = rows.size > 0;
  }
  function recording(initial: SourceView) {
    let source = initial, busy = false;
    records.set(source.id, source);
    let attempt: { name: string; key: string } | undefined;
    const article = el('article', 'vv-recording'), symbol = el('div', 'vv-recording-symbol'); symbol.setAttribute('aria-hidden', 'true');
    const body = el('div', 'vv-recording-body'), sourceName = el('h3', 'vv-recording-name', source.name), facts = el('div', 'vv-recording-facts');
    const profile = el('span', 'vv-recording-profile', source.fixtureId === FIXTURE_ID ? 'MIVIA 0062' : source.fixtureId);
    const version = el('span', '', `Version ${source.version}`); facts.append(profile, version);
    const created = el('time', 'vv-recording-date'), date = new Date(source.created);
    created.dateTime = date.toISOString();
    created.textContent = `Added ${date.toLocaleString(ctx.locale, { dateStyle: 'medium', timeStyle: 'short' })}`;
    body.append(sourceName, facts, created); article.append(symbol, body);
    const actions = el('div', 'vv-recording-actions'), detail = el('details', 'vv-recording-detail'), detailSummary = el('summary', '', 'Details');
    detailSummary.setAttribute('aria-label', `Details for ${source.name}`);
    const details = el('dl', 'vv-recording-detail-facts');
    for (const [label, value] of [['Source ID', source.id], ['Profile ID', source.fixtureId]]) { const fact = el('div'); fact.append(el('dt', '', label), el('dd', '', value)); details.append(fact); }
    detail.append(detailSummary, details); actions.append(detail); article.append(actions);
    if (canWrite) {
      const edit = el('details', 'vv-recording-edit'), summary = el('summary', '', 'Rename'), editForm = el('form');
      summary.setAttribute('aria-label', `Rename ${source.name}`);
      const nextName = field('Recording name', `recording-${source.id}`);
      nextName.input.value = source.name; nextName.input.maxLength = 160; nextName.input.setAttribute('autocomplete', 'off');
      const actions = el('div', 'vv-recording-edit-actions'), save = el('button', 'button small', 'Save name'); save.type = 'submit';
      const cancel = el('button', 'button small secondary', 'Cancel'); cancel.type = 'button';
      const status = el('p', 'vv-recording-save-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const updateSave = () => {
        save.disabled = busy || !nextName.input.value.trim() || nextName.input.value.trim() === source.name;
        save.textContent = busy ? 'Saving…' : 'Save name'; nextName.input.disabled = busy; cancel.disabled = busy;
        editForm.setAttribute('aria-busy', String(busy));
      };
      updateSave(); nextName.input.addEventListener('input', updateSave, { signal: ctx.signal });
      cancel.addEventListener('click', () => {
        if (!active() || busy) return;
        nextName.input.value = source.name; updateSave(); edit.open = false; summary.focus();
      }, { signal: ctx.signal });
      editForm.addEventListener('submit', async event => {
        event.preventDefault(); const value = nextName.input.value.trim();
        if (!active() || busy || !value || value === source.name) return;
        busy = true; updateSave(); status.textContent = ''; status.classList.remove('is-error');
        if (!attempt || attempt.name !== value) attempt = { name: value, key: crypto.randomUUID() };
        try {
          const saved = await ctx.api.post('/api/sources/rename', { sourceId: source.id, name: value }, attempt.key, ctx.signal) as SourceView;
          if (!active()) return;
          source = saved; sourceName.textContent = saved.name; version.textContent = `Version ${saved.version}`;
          records.set(saved.id, saved);
          summary.setAttribute('aria-label', `Rename ${saved.name}`);
          detailSummary.setAttribute('aria-label', `Details for ${saved.name}`);
          nextName.input.value = saved.name; attempt = undefined; edit.open = false; applyFilters();
          if (article.hidden) search.focus(); else summary.focus();
          message(`Recording renamed to “${saved.name}”.`);
        } catch (error) {
          if (active()) { status.textContent = errorText(error, 'The recording name could not be saved. Try again.'); status.classList.add('is-error'); }
        } finally { busy = false; if (active()) updateSave(); }
      }, { signal: ctx.signal });
      actions.append(save, cancel); editForm.append(nextName.wrap, actions, status); edit.append(summary, editForm); article.querySelector('.vv-recording-actions')!.append(edit);
    }
    return article;
  }
  name.input.addEventListener('input', updateRegister, { signal: ctx.signal });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const value = name.input.value.trim();
    if (!active() || registering || !loaded || !canWrite || !value) return;
    registering = true; updateRegister(); message('');
    if (!registration || registration.name !== value) registration = { name: value, key: crypto.randomUUID() };
    try {
      const saved = await ctx.api.post('/api/sources', { fixtureId: FIXTURE_ID, name: value }, registration.key, ctx.signal) as SourceView;
      if (!active()) return;
      if (!rows.has(saved.id)) { const article = recording(saved); rows.set(saved.id, article); list.prepend(article); }
      updateCount(); applyFilters(); registration = undefined; add.open = false; name.input.value = 'MIVIA video 0062'; addSummary.focus();
      message(`“${saved.name}” added to your library.${rows.get(saved.id)?.hidden ? ' Clear the current filters to see it.' : ''}`);
    } catch (error) { message(errorText(error, 'The recording could not be added. Try again.'), true); }
    finally { registering = false; if (active()) updateRegister(); }
  }, { signal: ctx.signal });
  async function load() {
    if (!active() || loading) return;
    loading = true; library.setAttribute('aria-busy', 'true');
    try {
      const data = await ctx.api.get('/api/sources', ctx.signal) as { items: SourceView[] };
      if (!active()) return;
      for (const source of data.items) {
        if (rows.has(source.id)) continue;
        const article = recording(source); rows.set(source.id, article); list.append(article);
      }
      loaded = true; updateCount(); applyFilters();
    } catch (error) {
      if (!active()) return;
      count.textContent = 'Library unavailable';
      placeholder.replaceChildren(el('h3', '', 'We couldn’t load your recordings'), el('p', '', errorText(error, 'Check your connection and try again.')));
      const retry = el('button', 'button secondary', 'Try again'); retry.type = 'button';
      retry.addEventListener('click', () => { retry.disabled = true; void load(); }, { signal: ctx.signal });
      placeholder.append(retry); placeholder.hidden = false;
    } finally { loading = false; if (active()) { library.setAttribute('aria-busy', 'false'); updateRegister(); } }
  }
  void load();
  return () => { closed = true; page.remove(); };
} };
