import type { Workspace } from '@quadbridge/contracts';
import { el, field } from '@quadbridge/web-shell/dom';
import { FIXTURE_ID, type SourceView } from './protocol.js';

export const workspace: Workspace = { mount(ctx) {
  const canWrite = ctx.permissions.includes('veyviz.sources.write');
  const page = el('section', 'veyviz-sources'), header = el('header', 'vv-library-heading'), title = el('div');
  title.append(el('span', 'vv-eyebrow', 'YOUR LIBRARY'), el('h1', '', 'Recordings'),
    el('p', 'vv-library-intro', 'Keep your team’s recording references in one place.'));
  const count = el('span', 'vv-library-count', 'Loading recordings');
  header.append(title, count); page.append(header);
  const feedback = el('p', 'vv-library-feedback');
  feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  let closed = false, loaded = false, loading = false, registering = false;
  let registration: { name: string; key: string } | undefined;
  const rows = new Map<string, HTMLElement>();
  const active = () => !closed && !ctx.signal.aborted;
  const message = (text: string, error = false) => {
    if (!active()) return;
    feedback.textContent = text; feedback.classList.toggle('is-error', error); feedback.hidden = !text;
  };
  const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
  const add = el('details', 'vv-library-add'), addSummary = el('summary'), addIcon = el('span', 'vv-add-icon', '+');
  addIcon.setAttribute('aria-hidden', 'true');
  addSummary.append(addIcon, el('span', 'vv-add-label', 'Add sample recording'), el('span', 'vv-add-hint', 'MIVIA 0062'));
  const addContent = el('div', 'vv-library-add-content'), description = el('div', 'vv-library-add-description');
  description.append(el('h3', '', 'Start with the local sample'),
    el('p', '', 'This workspace supports the installed MIVIA 0062 recording. Give it a name to add it to your library.'),
    el('p', 'vv-field-note', 'Each registration refers to the same sample. This does not upload a new video.'));
  const form = el('form', 'vv-library-add-form'), name = field('Recording name', 'recording-name');
  name.input.maxLength = 160; name.input.value = 'MIVIA video 0062'; name.input.setAttribute('autocomplete', 'off');
  const register = el('button', 'button', 'Add to library'); register.type = 'submit'; register.disabled = true;
  form.append(name.wrap, register); addContent.append(description, form); add.append(addSummary, addContent);
  if (canWrite) page.append(add);
  else page.append(el('p', 'vv-library-readonly', 'Read-only access · You can view the recordings available in this workspace.'));
  page.append(feedback);
  const library = el('section', 'vv-recording-library'); library.setAttribute('aria-label', 'Registered recordings');
  const libraryHeader = el('div', 'vv-library-list-heading');
  libraryHeader.append(el('h3', '', 'All recordings'), el('span', '', 'Local sample library'));
  const list = el('div', 'vv-recording-list'), placeholder = el('div', 'vv-library-empty');
  placeholder.append(el('p', '', 'Loading your recordings…'));
  library.append(libraryHeader, list, placeholder); page.append(library); ctx.root.append(page);

  function updateCount() { count.textContent = `${rows.size} ${rows.size === 1 ? 'recording' : 'recordings'}${rows.size >= 100 ? ' shown' : ''}`; }
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
    let attempt: { name: string; key: string } | undefined;
    const article = el('article', 'vv-recording'), symbol = el('div', 'vv-recording-symbol'); symbol.setAttribute('aria-hidden', 'true');
    const body = el('div', 'vv-recording-body'), sourceName = el('h3', 'vv-recording-name', source.name), facts = el('div', 'vv-recording-facts');
    const profile = el('span', 'vv-recording-profile', source.fixtureId === FIXTURE_ID ? 'MIVIA 0062' : source.fixtureId);
    const version = el('span', '', `Version ${source.version}`); facts.append(profile, version);
    const created = el('time', 'vv-recording-date'), date = new Date(source.created);
    created.dateTime = date.toISOString();
    created.textContent = `Added ${date.toLocaleString(ctx.locale, { dateStyle: 'medium', timeStyle: 'short' })}`;
    body.append(sourceName, facts, created); article.append(symbol, body);
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
          summary.setAttribute('aria-label', `Rename ${saved.name}`);
          nextName.input.value = saved.name; attempt = undefined; edit.open = false; summary.focus();
          message(`Recording renamed to “${saved.name}”.`);
        } catch (error) {
          if (active()) { status.textContent = errorText(error, 'The recording name could not be saved. Try again.'); status.classList.add('is-error'); }
        } finally { busy = false; if (active()) updateSave(); }
      }, { signal: ctx.signal });
      actions.append(save, cancel); editForm.append(nextName.wrap, actions, status); edit.append(summary, editForm); article.append(edit);
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
      updateCount(); placeholder.hidden = true; registration = undefined; add.open = false; name.input.value = 'MIVIA video 0062'; addSummary.focus();
      message(`“${saved.name}” added to your library.`);
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
      loaded = true; updateCount(); showEmpty();
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

