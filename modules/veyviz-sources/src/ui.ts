import type { Workspace } from '@quadbridge/contracts';
import { createCommandState, type CapturedCommandIntent } from '@quadbridge/client-core';
import { el, field } from '@quadbridge/web-shell/dom';
import { FIXTURE_ID, type SourceView } from './protocol.js';

const MAX_CURSOR_HISTORY = 100;

export const workspace: Workspace = { mount(ctx) {
  const canWrite = ctx.permissions.includes('veyviz.sources.write');
  const page = el('section', 'veyviz-sources'), header = el('header', 'vv-library-heading'), title = el('div');
  page.setAttribute('data-qb-ui-boundary', '');
  page.setAttribute('data-qb-surface', 'light');
  page.setAttribute('data-qb-text', 'standard');
  page.setAttribute('data-qb-accent', 'teal');
  page.setAttribute('data-qb-density', 'comfortable');
  page.setAttribute('data-qb-layout-mode', 'reading');
  title.append(el('p', 'vv-library-eyebrow', 'SOURCE LIBRARY'),
    el('h1', '', 'Recordings'),
    el('p', 'vv-library-intro', 'Your team’s registered recording references.'));
  const count = el('span', 'vv-library-count', 'Loading recordings');
  header.append(title, count); page.append(header);
  const feedback = el('p', 'vv-library-feedback');
  feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  let closed = false, loaded = false, loading = false, registering = false;
  let queryEpoch = 0, pageIndex = 0, pageBase = 0, nextCursor: string | undefined;
  let pageCursors: Array<string | undefined> = [undefined];
  const commandState = createCommandState({ scope: ctx.scope, actor: ctx.actor, signal: ctx.signal, isCurrent: () => !closed && !ctx.signal.aborted });
  const commandIntents = new Map<string, CapturedCommandIntent>();
  const capturesInProgress = new Set<string>();
  const registrationSlot = 'sources.register';
  const renameSlot = (sourceId: string) => `sources.rename:${sourceId}`;
  const commandStateFor = (slot: string) => { const intent = commandIntents.get(slot); return intent ? commandState.state(intent) : undefined; };
  const hasUnresolvedCommand = () => capturesInProgress.size > 0 || [...commandIntents.values()].some(intent => ['PREPARED', 'PENDING', 'UNKNOWN'].includes(commandState.state(intent) ?? ''));
  const unregisterNavigationGuard = ctx.navigation?.registerUnsavedGuard(() => {
    if (!hasUnresolvedCommand()) return true;
    message('Resolve the original command in this workspace before navigating away.');
    return false;
  });
  async function postCommand<T>(slot: string, operation: string, payload: unknown, path: string): Promise<T> {
    if (!active()) throw new DOMException('Workspace closed', 'AbortError');
    capturesInProgress.add(slot);
    let intent: CapturedCommandIntent;
    try {
      intent = await commandState.capture(slot, operation, payload);
      commandIntents.set(slot, intent);
    } finally { capturesInProgress.delete(slot); }
    const dispatch = (id: string, body: import('@quadbridge/contracts').Json) => ctx.api.post(path, body, id, ctx.signal) as Promise<T>;
    try {
      const result = commandState.state(intent) === 'UNKNOWN'
        ? await commandState.retry(intent, dispatch)
        : await commandState.send(intent, dispatch);
      if (commandState.state(intent) === 'COMMITTED' && commandIntents.get(slot) === intent) commandIntents.delete(slot);
      return result;
    } catch (error) {
      if (commandState.state(intent) === 'REJECTED_NO_BUSINESS_EFFECTS' && commandIntents.get(slot) === intent) commandIntents.delete(slot);
      throw error;
    }
  }
  const mutationError = (slot: string, error: unknown, label: string) => commandStateFor(slot) === 'UNKNOWN'
    ? `${label} outcome is unknown. Retry the exact original request before changing its values or leaving this workspace.`
    : errorText(error, `${label} could not be completed.`);
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
  search.type = 'search'; search.placeholder = 'Search recording names or IDs'; search.maxLength = 200; searchLabel.append(search);
  const filterLabel = el('label', 'vv-library-filter'), filter = el('select');
  filterLabel.append(el('span', 'vv-sr-only', 'Filter recordings'));
  for (const [value, label] of [['all', 'All recordings'], ['renamed', 'Renamed recordings']] as const) { const option = el('option', '', label); option.value = value; filter.append(option); }
  filterLabel.append(filter);
  toolbar.append(searchLabel, filterLabel); page.append(toolbar);
  page.append(el('p', 'vv-library-scope', 'Search applies across registered names and IDs. Changes between page requests can shift page membership.'));
  const library = el('section', 'vv-recording-library'); library.setAttribute('aria-label', 'Registered recordings');
  const libraryHeader = el('div', 'vv-library-list-heading'), resultCount = el('h2', '', 'Recording library');
  resultCount.setAttribute('role', 'status'); resultCount.setAttribute('aria-live', 'polite');
  libraryHeader.append(resultCount, el('span', 'vv-recorded-label', 'RECORDED MEDIA'));
  const list = el('div', 'vv-recording-list'), placeholder = el('div', 'vv-library-empty');
  placeholder.append(el('p', '', 'Loading your recordings…'));
  const pager = el('nav', 'vv-library-pager'); pager.setAttribute('aria-label', 'Recording pages');
  const previousPage = el('button', 'button secondary', 'Previous'); previousPage.type = 'button'; previousPage.disabled = true;
  const pageStatus = el('span', 'vv-library-page-status', 'Page 1'); pageStatus.setAttribute('role', 'status'); pageStatus.setAttribute('aria-live', 'polite');
  const nextPage = el('button', 'button secondary', 'Next'); nextPage.type = 'button'; nextPage.disabled = true;
  pager.append(previousPage, pageStatus, nextPage);
  library.append(libraryHeader, list, placeholder, pager); page.append(library); ctx.root.append(page);

  function updateCount() { count.textContent = `${pageBase + pageIndex + 1} · ${rows.size} shown`; }
  function resetPage() {
    pageCursors = [undefined]; pageIndex = 0; pageBase = 0; nextCursor = undefined;
    previousPage.disabled = true; nextPage.disabled = true; pageStatus.textContent = 'Page 1';
    void load();
  }
  search.addEventListener('input', resetPage, { signal: ctx.signal });
  filter.addEventListener('change', resetPage, { signal: ctx.signal });
  previousPage.addEventListener('click', () => {
    if (pageIndex === 0 || !active()) return;
    pageIndex--; nextCursor = undefined; nextPage.disabled = true; previousPage.disabled = pageIndex === 0; void load();
  }, { signal: ctx.signal });
  nextPage.addEventListener('click', () => {
    if (!nextCursor || !active()) return;
    pageCursors = pageCursors.slice(0, pageIndex + 1); pageCursors.push(nextCursor); pageIndex++;
    if (pageCursors.length > MAX_CURSOR_HISTORY) { pageCursors.shift(); pageIndex--; pageBase++; }
    nextCursor = undefined;
    previousPage.disabled = false; nextPage.disabled = true; void load();
  }, { signal: ctx.signal });
  function updateRegister() {
    const state = commandStateFor(registrationSlot), unresolved = state === 'PREPARED' || state === 'PENDING' || state === 'UNKNOWN';
    const intent = commandIntents.get(registrationSlot);
    if (state === 'UNKNOWN' && intent?.payload && typeof intent.payload === 'object' && !Array.isArray(intent.payload)) {
      const originalName = intent.payload.name;
      if (typeof originalName === 'string') name.input.value = originalName;
    }
    const unknown = state === 'UNKNOWN';
    register.disabled = registering || !loaded || (!unknown && !name.input.value.trim());
    register.textContent = registering ? 'Adding recording…' : unknown ? 'Retry original registration' : 'Add to library';
    name.input.disabled = registering || unresolved; form.setAttribute('aria-busy', String(registering));
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
    const slot = renameSlot(source.id);
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
        const state = commandStateFor(slot), unresolved = state === 'PREPARED' || state === 'PENDING' || state === 'UNKNOWN';
        const intent = commandIntents.get(slot);
        if (state === 'UNKNOWN' && intent?.payload && typeof intent.payload === 'object' && !Array.isArray(intent.payload)) {
          const originalName = intent.payload.name;
          if (typeof originalName === 'string') nextName.input.value = originalName;
          status.textContent = 'Rename outcome unknown. Retry the original name before editing or leaving this workspace.';
          status.classList.remove('is-error');
        }
        const unknown = state === 'UNKNOWN';
        save.disabled = busy || (!unknown && (!nextName.input.value.trim() || nextName.input.value.trim() === source.name));
        save.textContent = busy ? 'Saving…' : unknown ? 'Retry original rename' : 'Save name'; nextName.input.disabled = busy || unresolved; cancel.disabled = busy || unresolved;
        editForm.setAttribute('aria-busy', String(busy));
      };
      updateSave(); nextName.input.addEventListener('input', updateSave, { signal: ctx.signal });
      cancel.addEventListener('click', () => {
        if (!active() || busy || commandStateFor(slot) === 'UNKNOWN' || commandStateFor(slot) === 'PENDING') return;
        nextName.input.value = source.name; updateSave(); edit.open = false; summary.focus();
      }, { signal: ctx.signal });
      editForm.addEventListener('submit', async event => {
        event.preventDefault(); const value = nextName.input.value.trim();
        if (!active() || busy || !value || (value === source.name && commandStateFor(slot) !== 'UNKNOWN')) return;
        busy = true; updateSave(); status.textContent = ''; status.classList.remove('is-error');
        try {
          const saved = await postCommand<SourceView>(slot, 'veyviz.sources.rename', { sourceId: source.id, name: value }, '/api/sources/rename');
          if (!active()) return;
          source = saved; sourceName.textContent = saved.name; version.textContent = `Version ${saved.version}`;
          records.set(saved.id, saved);
          summary.setAttribute('aria-label', `Rename ${saved.name}`);
          detailSummary.setAttribute('aria-label', `Details for ${saved.name}`);
          nextName.input.value = saved.name; edit.open = false;
          await load();
          if (rows.has(saved.id)) summary.focus(); else search.focus();
          message(`Recording renamed to “${saved.name}”.`);
        } catch (error) {
          if (active()) { status.textContent = mutationError(slot, error, 'Rename'); status.classList.add('is-error'); updateSave(); }
        } finally { busy = false; if (active()) updateSave(); }
      }, { signal: ctx.signal });
      actions.append(save, cancel); editForm.append(nextName.wrap, actions, status); edit.append(summary, editForm); article.querySelector('.vv-recording-actions')!.append(edit);
    }
    return article;
  }
  name.input.addEventListener('input', updateRegister, { signal: ctx.signal });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const value = name.input.value.trim();
    if (!active() || registering || !loaded || !canWrite || (!value && commandStateFor(registrationSlot) !== 'UNKNOWN')) return;
    registering = true; updateRegister(); message('');
    try {
      const saved = await postCommand<SourceView>(registrationSlot, 'veyviz.sources.register', { fixtureId: FIXTURE_ID, name: value }, '/api/sources');
      if (!active()) return;
      add.open = false; name.input.value = 'MIVIA video 0062';
      await load(); addSummary.focus();
      message(`“${saved.name}” added to your library. The current search and filters remain applied.`);
    } catch (error) { message(mutationError(registrationSlot, error, 'Registration'), true); }
    finally { registering = false; if (active()) updateRegister(); }
  }, { signal: ctx.signal });
  async function load() {
    if (!active()) return;
    const epoch = ++queryEpoch;
    loading = true; library.setAttribute('aria-busy', 'true');
    previousPage.disabled = pageIndex === 0; nextPage.disabled = true; pageStatus.textContent = `Loading page ${pageBase + pageIndex + 1}`;
    try {
      const parameters = new URLSearchParams();
      const query = search.value.trim();
      if (query) parameters.set('search', query);
      if (filter.value === 'renamed') parameters.set('renamedOnly', 'true');
      parameters.set('limit', '20');
      const cursor = pageCursors[pageIndex];
      if (cursor) parameters.set('cursor', cursor);
      const data = await ctx.api.get('/api/sources/query?' + parameters.toString(), ctx.signal) as { items: SourceView[]; page: { limit: number; nextCursor?: string; coverage: string } };
      if (!active() || epoch !== queryEpoch) return;
      if (!Array.isArray(data.items) || !data.page || data.page.limit !== 20 || data.page.coverage !== 'filtered-owner-query') throw Error('The recording query response is invalid.');
      const present = new Set(data.items.map(source => source.id));
      for (const [id, article] of rows) {
        if (present.has(id)) continue;
        if (article.contains(document.activeElement)) search.focus();
        article.remove(); rows.delete(id); records.delete(id);
      }
      records.clear();
      for (const source of data.items) {
        records.set(source.id, source);
        let article = rows.get(source.id);
        if (!article) { article = recording(source); rows.set(source.id, article); }
        list.append(article);
      }
      nextCursor = data.page.nextCursor;
      loaded = true; updateCount();
      resultCount.textContent = `${rows.size} ${rows.size === 1 ? 'recording' : 'recordings'} · page ${pageBase + pageIndex + 1}`;
      placeholder.hidden = rows.size > 0;
      if (!rows.size && (query || filter.value === 'renamed')) {
        const clear = el('button', 'button secondary', 'Clear search and filters'); clear.type = 'button';
        clear.addEventListener('click', () => { search.value = ''; filter.value = 'all'; resetPage(); search.focus(); }, { signal: ctx.signal });
        placeholder.replaceChildren(el('h3', '', 'No recordings match this search'), el('p', '', 'Search covers registered recording names and IDs. You can remove the renamed-only filter or try another term.'), clear);
      } else if (!rows.size) showEmpty();
      previousPage.disabled = pageIndex === 0;
      nextPage.disabled = !nextCursor;
      pageStatus.textContent = `Page ${pageBase + pageIndex + 1}${nextCursor ? ' · More results' : ''}`;
    } catch (error) {
      if (!active() || epoch !== queryEpoch) return;
      count.textContent = 'Library unavailable';
      pageStatus.textContent = `Page ${pageBase + pageIndex + 1} unavailable`;
      if (!loaded || !rows.size) {
        placeholder.replaceChildren(el('h3', '', 'We couldn’t load your recordings'), el('p', '', errorText(error, 'Check your connection and try again.')));
        const retry = el('button', 'button secondary', 'Try again'); retry.type = 'button';
        retry.addEventListener('click', () => { retry.disabled = true; void load(); }, { signal: ctx.signal });
        placeholder.append(retry); placeholder.hidden = false;
      } else message(errorText(error, 'The current recording page could not be refreshed.'), true);
    } finally {
      if (epoch === queryEpoch) { loading = false; if (active()) { library.setAttribute('aria-busy', 'false'); updateRegister(); } }
    }
  }
  void load();
  return () => { closed = true; unregisterNavigationGuard?.(); commandState.dispose(); page.remove(); };
} };
