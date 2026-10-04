import type { Workspace } from '@quadbridge/contracts';
import { el, button } from '@quadbridge/web-shell/dom';
import type { Source, RecordingView, Point, TemporalResult, Event, Appearance } from './protocol.js';

export const workspace: Workspace = { mount(ctx) {
  const page = el('section', 'vi-page'), heading = el('header', 'vi-heading');
  heading.append(el('h1', '', 'Recording intelligence'), el('p', '', 'Appearances, drawn zones and supporting footage'));
  page.append(heading);
  const status = el('p', 'vi-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); page.append(status);
  const canWrite = ctx.permissions.includes('veyviz.intelligence.write');
  const controls = el('div', 'vi-controls'), catalogSelect = el('select'), sourceSelect = el('select'), runSelect = el('select');
  catalogSelect.setAttribute('aria-label', 'Admitted recording'); sourceSelect.setAttribute('aria-label', 'Registered recording'); runSelect.setAttribute('aria-label', 'Analysis run');
  const add = button('Register recording', () => void guarded(async () => { await ctx.api.post('/api/intelligence/sources', { recordingId: catalogSelect.value }, crypto.randomUUID(), ctx.signal); await loadSources(); }));
  if (canWrite) controls.append(catalogSelect, add); controls.append(sourceSelect, runSelect); page.append(controls);
  const grid = el('div', 'vi-grid'), main = el('div'), rail = el('aside'); grid.append(main, rail); page.append(grid);
  const stage = el('div', 'vi-stage'), video = el('video'), canvas = el('canvas');
  video.controls = true; video.preload = 'metadata'; video.setAttribute('aria-label', 'Recording playback'); canvas.width = 1000; canvas.height = 600; canvas.hidden = true;
  stage.append(video, canvas); main.append(stage);
  const clock = el('p', 'vi-clock'); main.append(clock);
  const note = el('p', 'vi-note', 'Sampled observations. Motion-skipped time cannot establish absence. Appearance groups and face/plate matches require review; physical uniqueness and occupancy remain unknown.'); main.append(note);
  const draw = el('div', 'vi-controls'), polygon = button('Draw zone', () => { points = []; drawing = true; canvas.hidden = false; canvas.style.pointerEvents = 'auto'; status.textContent = 'Click at least three polygon corners, then save the zone.'; paint(); });
  const zoneName = el('input'); zoneName.value = 'zone-1'; zoneName.maxLength = 128; zoneName.setAttribute('aria-label', 'Zone ID');
  const save = button('Save zone', () => void guarded(async () => {
    const source = sources.find(s => s.sourceId === sourceSelect.value); if (!source || points.length < 3) throw Error('Draw at least three polygon corners');
    await ctx.api.post('/api/intelligence/geometry', { sourceId: source.sourceId, geometry: { version: source.geometry.version + 1, zones: [...source.geometry.zones.filter(z => z.id !== zoneName.value), { id: zoneName.value, points }] } }, crypto.randomUUID(), ctx.signal);
    drawing = false; canvas.style.pointerEvents = 'none'; await loadSources(); status.textContent = 'Zone saved. A new run will use this geometry.';
  }));
  if (canWrite) { draw.append(polygon, zoneName, save, button('Cancel drawing', () => { drawing = false; canvas.style.pointerEvents = 'none'; paint(); })); main.append(draw); }
  const form = el('form', 'vi-controls'), start = el('input'), end = el('input'), interval = el('select');
  for (const [input, label, value] of [[start, 'Start seconds', '0'], [end, 'End seconds', '22']] as const) { input.type = 'number'; input.min = '0'; input.step = '.001'; input.value = value; input.setAttribute('aria-label', label); const wrap = el('label'); wrap.append(el('span', '', label), input); form.append(wrap); }
  interval.setAttribute('aria-label', 'Detection interval'); for (const [value, label] of [['500', '2 detections / second'], ['1000', '1 detection / second'], ['2000', '1 detection / 2 seconds']]) { const option = el('option', '', label); option.value = value!; interval.append(option); } interval.value = '1000'; form.append(interval);
  const options = el('fieldset', 'vi-options'); options.append(el('legend', '', 'Processing'));
  const checkbox = (label: string, checked = true) => { const input = el('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label); const wrap = el('label'); wrap.append(input, el('span', '', label)); options.append(wrap); return input; };
  const advanced = checkbox('Advanced analysis', false), persons = checkbox('People'), vehicles = checkbox('Vehicles'), animals = checkbox('Animals'), motion = checkbox('Motion filtering'), visual = checkbox('Image/text features'), faces = checkbox('Face match candidates'), plates = checkbox('Plate OCR candidates');
  const execution = el('select'); execution.setAttribute('aria-label', 'Execution'); for (const value of ['CUDA', 'CPU']) { const option = el('option', '', value === 'CUDA' ? 'Laptop GPU (CUDA)' : 'CPU'); option.value = value; execution.append(option); } options.append(execution); form.append(options);
  const selectedProcessing = () => advanced.checked ? { categories: [persons.checked ? 'person' : '', vehicles.checked ? 'vehicle' : '', animals.checked ? 'animal' : ''].filter(Boolean), execution: execution.value, motion: { enabled: motion.checked, threshold: .002, heartbeatMs: 2000 }, visual: visual.checked, face: faces.checked, plate: plates.checked } : undefined;
  const analyze = el('button', 'button', 'Analyze interval'); analyze.type = 'submit'; form.append(analyze);
  form.addEventListener('submit', event => { event.preventDefault(); void guarded(async () => { const processing = selectedProcessing(); const created = await ctx.api.post('/api/intelligence/runs', { sourceId: sourceSelect.value, startMs: Math.round(Number(start.value) * 1000), endMs: Math.round(Number(end.value) * 1000), sampleIntervalMs: Number(interval.value), ...(processing ? { processing } : {}) }, crypto.randomUUID(), ctx.signal) as { runId: string }; selectedRun = created.runId; await loadRuns(); status.textContent = 'Analysis queued. Results appear after execution and Product acceptance.'; }); });
  if (canWrite) main.append(form);
  const summary = el('p', 'vi-summary'), timeline = el('div', 'vi-timeline'); timeline.setAttribute('aria-label', 'Event timeline'); main.append(summary, timeline);
  const filters = el('div', 'vi-controls'), category = el('select'), eventType = el('select'), search = el('input');
  category.setAttribute('aria-label', 'Category'); for (const [value, label] of [['', 'All categories'], ['person', 'Person'], ['vehicle', 'Vehicle'], ['animal', 'Animal']]) { const option = el('option', '', label); option.value = value!; category.append(option); }
  eventType.setAttribute('aria-label', 'Event type'); for (const [value, label] of [['', 'All events'], ['presence', 'Presence'], ['zone_entered', 'Zone entry'], ['zone_exited', 'Zone exit']]) { const option = el('option', '', label); option.value = value!; eventType.append(option); }
  search.type = 'search'; search.placeholder = 'Search accepted descriptions'; search.maxLength = 160; search.setAttribute('aria-label', 'Search descriptions'); filters.append(category, eventType, search); rail.append(filters);
  const eventList = el('div', 'vi-events'), appearances = el('div', 'vi-appearances'), visits = el('div', 'vi-visits'); rail.append(el('h2', '', 'Events'), eventList, el('h2', '', 'Appearances'), appearances, el('h2', '', 'Zone visits'), visits);
  if (canWrite) rail.append(button('Cancel selected run', () => void guarded(async () => { if (!selectedRun) return; await ctx.api.post('/api/intelligence/cancel', { runId: selectedRun }, crypto.randomUUID(), ctx.signal); await refreshRun(); })));
  const intelligence = el('section', 'vi-tools'); page.append(intelligence);
  const facts = el('div', 'vi-facts'); intelligence.append(el('h2', '', 'Activity summary'), facts, button('Summarize recent accepted runs', () => void guarded(async () => { await loadRuns(); const ids = listedRuns.filter(r => r.state === 'SUCCEEDED').slice(0,100).map(r => r.runId); if (!ids.length) throw Error('No accepted runs'); const data = await ctx.api.get('/api/intelligence/summary?runIds=' + encodeURIComponent(ids.join(',')), ctx.signal) as { summary: string; categories: Record<string,{trackedAppearances:number;zoneEntries:number;reviewedEntities:number}> }; facts.replaceChildren(el('p','',data.summary)); for(const [name,count] of Object.entries(data.categories)) facts.append(el('p','', `${name}: ${count.trackedAppearances} appearances · ${count.zoneEntries} entries · ${count.reviewedEntities} reviewed anonymous entities`)); }))); 
  const retrieval = el('form', 'vi-controls'), retrievalMode = el('select'), query = el('input'), reference = el('input'), allRuns = el('input'), allLabel = el('label'), matches = el('div', 'vi-matches');
  retrievalMode.setAttribute('aria-label', 'Forensic search mode'); for (const [value, label] of [['text', 'Description → image search'], ['image', 'Reference image similarity'], ['face', 'Possible face matches'], ['plate', 'Plate OCR candidates']]) { const option = el('option', '', label); option.value = value!; retrievalMode.append(option); }
  query.setAttribute('aria-label', 'Forensic search query'); query.placeholder = 'Person in blue, red car, plate text…'; query.maxLength = 512;
  reference.type = 'file'; reference.accept = 'image/jpeg,image/png'; reference.setAttribute('aria-label', 'Reference photo');
  allRuns.type = 'checkbox'; allRuns.setAttribute('aria-label', 'Search all accepted runs'); allLabel.append(allRuns, el('span', '', 'Most recent 100 accepted runs'));
  const searchButton = el('button', 'button', 'Search evidence'); searchButton.type = 'submit'; retrieval.append(retrievalMode, query, reference, allLabel, searchButton); intelligence.append(el('h2', '', 'Forensic search'), retrieval, matches);
  let referenceBase64 = '', listedRuns: { runId: string; sourceId: string; state: string }[] = [];
  reference.addEventListener('change', () => void guarded(async () => { const file = reference.files?.[0]; referenceBase64 = ''; if (!file) return; if (file.size > 8 * 1024 * 1024) throw Error('Reference photo exceeds 8 MiB'); const bitmap = await createImageBitmap(file); try { if (bitmap.width * bitmap.height > 32 * 1024 * 1024) throw Error('Reference photo dimensions exceed their bound'); const output = el('canvas'), scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height)); output.width = Math.max(1, Math.round(bitmap.width * scale)); output.height = Math.max(1, Math.round(bitmap.height * scale)); output.getContext('2d')!.drawImage(bitmap, 0, 0, output.width, output.height); referenceBase64 = output.toDataURL('image/jpeg', .65).split(',')[1]!; if (referenceBase64.length > 131072) { referenceBase64 = ''; throw Error('Use a smaller reference photo'); } status.textContent = 'Reference photo prepared locally.'; } finally { bitmap.close(); } }));
  retrieval.addEventListener('submit', event => { event.preventDefault(); void guarded(async () => { const runIds = allRuns.checked ? listedRuns.filter(r => r.state === 'SUCCEEDED').slice(0, 100).map(r => r.runId) : [selectedRun]; const data = await ctx.api.post('/api/intelligence/retrieval', { runIds, mode: retrievalMode.value, q: query.value, reference: referenceBase64, category: category.value }, crypto.randomUUID(), ctx.signal) as { items: (Appearance & { runId: string; score: number; qualification: string })[] }; matches.replaceChildren(); for (const item of data.items) { const card = appearanceCard(item, item.runId); card.append(el('p', '', `${item.qualification.replaceAll('_', ' ')} · similarity ${item.score.toFixed(3)}`), button('Open matched run', () => void guarded(async () => { await openRun(item.runId); const event = result?.events.find(e => e.appearanceId === item.id); if (event) await playback(event); }))); matches.append(card); } if (!data.items.length) matches.append(el('p', '', 'No compatible accepted evidence matches this query.')); }); });
  const operations = el('div', 'vi-controls'), prefix = el('input'), operational = el('div'); prefix.setAttribute('aria-label', 'Segment recording prefix'); prefix.placeholder = 'cam05-live-'; prefix.maxLength = 80;
  if (canWrite) {
    operations.append(prefix, button('Analyze admitted segments', () => void guarded(async () => { const data = await ctx.api.get('/api/intelligence/catalog', ctx.signal) as { items: RecordingView[] }; const recordingIds = data.items.filter(r => r.id.startsWith(prefix.value)).map(r => r.id); if (!prefix.value || !recordingIds.length) throw Error('Choose an admitted segment prefix'); const processing = selectedProcessing(); await ctx.api.post('/api/intelligence/batches', { recordingIds, templateSourceId: sourceSelect.value, endMs: Math.round(Number(end.value) * 1000), sampleIntervalMs: Number(interval.value), ...(processing ? { processing } : {}) }, crypto.randomUUID(), ctx.signal); await loadSources(); await loadRuns(); await loadOperations(); })), button('Watch new segments', () => void guarded(async () => { const processing = selectedProcessing(); await ctx.api.post('/api/intelligence/watches', { prefix: prefix.value, templateSourceId: sourceSelect.value, endMs: Math.round(Number(end.value) * 1000), sampleIntervalMs: Number(interval.value), ...(processing ? { processing } : {}) }, crypto.randomUUID(), ctx.signal); await loadOperations(); status.textContent = 'Watch enabled for admitted segments. Start the authorized capture tool to supply a live feed.'; })));
  }
  intelligence.append(el('h2', '', 'Recording batches and live analysis'), el('p', 'vi-note', 'Long recordings and live feeds supply immutable segments through the operator ingest tool. Watches continue under your retained grants after restart. Updates follow segment closure and accepted analysis.'), operations, operational);
  const alerts = el('div', 'vi-alerts'); intelligence.append(el('h2', '', 'Alerts'), alerts);
  if (canWrite) intelligence.append(button('Alert on zone entry', () => void guarded(async () => { const source = sources.find(s => s.sourceId === sourceSelect.value); if (!source?.geometry.zones.length) throw Error('Draw and save a zone first'); await ctx.api.post('/api/intelligence/rules', { sourceId: source.sourceId, name: 'Drawn zone entry', category: category.value, type: 'zone_entered', zoneId: source.geometry.zones[0]!.id, dwellMs: 0, enabled: true }, crypto.randomUUID(), ctx.signal); status.textContent = 'Alert rule saved. It applies to newly accepted runs and segments using this template.'; })));
  const ruleList = el('div', 'vi-rules'); intelligence.append(el('h2', '', 'Alert rules'), ruleList);
  if (canWrite) {
    const ruleForm = el('form','vi-controls'), ruleName = el('input'), ruleType = el('select'), dwell = el('input');
    ruleName.setAttribute('aria-label','Alert rule name'); ruleName.value='Zone review'; ruleName.maxLength=100;
    ruleType.setAttribute('aria-label','Alert rule event'); for (const [value,label] of [['zone_entered','Zone entry'],['zone_exited','Zone exit'],['presence','Presence'],['dwell','Observed dwell']]) { const option=el('option','',label);option.value=value!;ruleType.append(option); }
    dwell.type='number';dwell.min='0';dwell.max='120';dwell.value='10';dwell.setAttribute('aria-label','Dwell threshold seconds');const create=el('button','button','Save alert rule');create.type='submit';ruleForm.append(ruleName,ruleType,dwell,create);
    ruleForm.addEventListener('submit',event=>{event.preventDefault();void guarded(async()=>{const source=sources.find(s=>s.sourceId===sourceSelect.value);if(!source)throw Error('Select a recording template');await ctx.api.post('/api/intelligence/rules',{sourceId:source.sourceId,name:ruleName.value,category:category.value,type:ruleType.value,zoneId:ruleType.value==='presence'?'':zoneName.value,dwellMs:Math.round(Number(dwell.value)*1000),enabled:true},crypto.randomUUID(),ctx.signal);await loadOperations();status.textContent='Alert rule saved for future accepted evidence.';});});intelligence.append(ruleForm,el('p','vi-note','Zone rules use the Zone ID field above. Dwell is measured between sampled observations; it does not prove uninterrupted occupancy.'));
  }
  ctx.root.append(page);
  let sources: Source[] = [], selectedRun = '', result: TemporalResult | null = null, points: Point[] = [], drawing = false, closed = false, busy = false, polling = false;
  let currentRecording: Source | undefined;
  let playbackGrant: { sourceId: string; path: string; expiresAt: number } | undefined;
  let terminal = false;
  const active = () => !closed && !ctx.signal.aborted;
  const timestamp = (ms: number) => currentRecording?.captureStartUtc ? new Date(Date.parse(currentRecording.captureStartUtc) + ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : `${(ms / 1000).toFixed(2)}s`;
  async function guarded(work: () => Promise<void>) { if (busy || !active()) return; busy = true; analyze.disabled = add.disabled = save.disabled = true; try { await work(); } catch (error) { if (active()) status.textContent = error instanceof Error ? error.message : 'Operation failed'; } finally { busy = false; if (active()) analyze.disabled = add.disabled = save.disabled = false; } }
  function paint() { const brush = canvas.getContext('2d'); if (!brush) return; brush.clearRect(0, 0, canvas.width, canvas.height); brush.strokeStyle = '#20d4b1'; brush.fillStyle = '#20d4b122'; brush.lineWidth = Math.max(3, canvas.width / 500); const zones = drawing ? [{ id: zoneName.value, points }] : currentRecording?.geometry.zones ?? []; for (const zone of zones) { brush.beginPath(); zone.points.forEach(([x, y], i) => i ? brush.lineTo(x * canvas.width, y * canvas.height) : brush.moveTo(x * canvas.width, y * canvas.height)); if (zone.points.length > 2) { brush.closePath(); brush.fill(); } brush.stroke(); if (zone.points[0]) { brush.font = `${Math.max(16, canvas.width / 50)}px sans-serif`; brush.fillStyle = '#20d4b1'; brush.fillText(zone.id, zone.points[0][0] * canvas.width, zone.points[0][1] * canvas.height); brush.fillStyle = '#20d4b122'; } } }
  canvas.addEventListener('click', event => { if (!drawing || points.length >= 16) return; const rect = canvas.getBoundingClientRect(); points.push([(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height]); paint(); });
  video.addEventListener('loadedmetadata', () => { if (video.videoWidth) { stage.style.aspectRatio = `${video.videoWidth}/${video.videoHeight}`; canvas.width = video.videoWidth; canvas.height = video.videoHeight; paint(); } });
  video.addEventListener('timeupdate', () => { if (active()) clock.textContent = timestamp(video.currentTime * 1000) + (currentRecording?.clockUncertaintyMs !== null && currentRecording?.clockUncertaintyMs !== undefined ? ` · clock uncertainty ±${currentRecording.clockUncertaintyMs}ms` : ' · capture wall-clock unknown'); });
  async function playback(event?: Event) {
    if (playbackGrant?.sourceId === sourceSelect.value && playbackGrant.expiresAt > Date.now() + 5000 && video.readyState >= 1) { video.currentTime = event ? event.positionMs / 1000 : 0; return; }
    const body = event ? { runId: selectedRun, eventId: event.id } : { sourceId: sourceSelect.value };
    const data = await ctx.api.post('/api/intelligence/playback', body, crypto.randomUUID(), ctx.signal) as { path: string; positionMs: number; expiresAt: number };
    if (!active()) return;
    video.src = data.path;
    playbackGrant = { sourceId: sourceSelect.value, path: data.path, expiresAt: data.expiresAt };
    video.addEventListener('loadedmetadata', () => { video.currentTime = data.positionMs / 1000; }, { once: true });
    video.load();
  }
  async function openRun(runId: string) {
    const row = await ctx.api.get(`/api/intelligence/run?runId=${encodeURIComponent(runId)}`, ctx.signal) as { sourceId: string };
    await loadSources(); sourceSelect.value = row.sourceId; currentRecording = sources.find(s => s.sourceId === row.sourceId); selectedRun = runId; terminal = false; paint(); await playback(); await loadRuns();
  }
  async function pages<T>(path: string): Promise<T[]> {
    let cursor: string | null = null; const items: T[] = [];
    do { const data: { items: T[]; nextCursor: string | null } = await ctx.api.get(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), ctx.signal) as { items: T[]; nextCursor: string | null }; items.push(...data.items); cursor = data.nextCursor; if (items.length > 10000) throw Error('Narrow this workspace to 10,000 records'); } while (cursor && active()); return items;
  }
  async function loadSources() {
    const data = { items: await pages<Source>('/api/intelligence/sources') }; if (!active()) return;
    sources = data.items; const previous = sourceSelect.value; sourceSelect.replaceChildren(); for (const source of sources) { const option = el('option', '', source.name); option.value = source.sourceId; sourceSelect.append(option); } if (sources.some(s => s.sourceId === previous)) sourceSelect.value = previous;
    currentRecording = sources.find(s => s.sourceId === sourceSelect.value);
    canvas.hidden = !currentRecording; canvas.style.pointerEvents = drawing ? 'auto' : 'none'; paint();
    if (currentRecording) { status.textContent = ''; await playback(); } else status.textContent = 'Register an admitted recording to begin.';
  }
  async function loadRuns() { const data = { items: await pages<{ runId: string; sourceId: string; state: string }>('/api/intelligence/runs') }; if (!active()) return; listedRuns = data.items; runSelect.replaceChildren(); for (const run of data.items.filter(r => r.sourceId === sourceSelect.value)) { const option = el('option', '', `${run.state} · ${run.runId.slice(0, 8)}`); option.value = run.runId; runSelect.append(option); } if ([...runSelect.options].some(o => o.value === selectedRun)) runSelect.value = selectedRun; else selectedRun = runSelect.value; await refreshRun(); }
  function appearanceCard(a: Appearance, runId = selectedRun) {
    const card = el('article', 'vi-card');
    if (a.thumbnailJpegBase64) { const image = el('img'); image.src = 'data:image/jpeg;base64,' + a.thumbnailJpegBase64; image.alt = `Evidence for ${a.id}`; card.append(image); }
    const time = runId === selectedRun ? `${timestamp(a.firstMs)}–${timestamp(a.lastMs)}` : `${(a.firstMs / 1000).toFixed(2)}–${(a.lastMs / 1000).toFixed(2)}s in matched run`;
    card.append(el('h3', '', `${a.category} · ${a.id}`), el('p', '', a.description), el('p', '', `${time} · ${a.observations} observations`));
    const event = runId === selectedRun ? result?.events.find(e => e.appearanceId === a.id) : undefined;
    if (event) card.append(button('Jump to footage', () => void guarded(() => playback(event))));
    if (a.plateCandidates?.length) card.append(el('p', '', 'OCR candidates: ' + a.plateCandidates.map(p => `${p.text} (${p.confidence.toFixed(2)})`).join(', ')));
    if (canWrite) {
      const entity = el('input'), label = el('input'); entity.placeholder = 'Anonymous entity ID'; entity.maxLength = 80; entity.setAttribute('aria-label', `Entity ID for ${a.id}`); label.placeholder = 'Review label'; label.maxLength = 80; label.setAttribute('aria-label', `Review label for ${a.id}`);
      card.append(entity, label, button('Confirm anonymous entity link', () => void guarded(async () => { await ctx.api.post('/api/intelligence/entities/link', { runId, appearanceId: a.id, entityId: entity.value, label: label.value }, crypto.randomUUID(), ctx.signal); if (runId === selectedRun) await refreshRun(); status.textContent = 'Anonymous entity link recorded with your review. Physical uniqueness remains unverified.'; })));
    }
    return card;
  }
  async function renderEvents() {
    if (!result || !selectedRun) return;
    const runId = selectedRun;
    const data = await ctx.api.get(`/api/intelligence/events?runId=${encodeURIComponent(runId)}&type=${eventType.value}&category=${category.value}`, ctx.signal) as { items: Event[]; nextCursor: string | null };
    if (!active() || selectedRun !== runId) return;
    eventList.replaceChildren(); for (const event of data.items) eventList.append(button(`${timestamp(event.positionMs)} · ${event.type.replaceAll('_', ' ')}${event.zoneId ? ' · ' + event.zoneId : ''}`, () => void guarded(() => playback(event))));
    if (data.nextCursor) eventList.append(el('p', '', 'Showing first100 events. Full pagination is available through the events API.'));
    if (!data.items.length) eventList.append(el('p', '', 'No events for this filter.'));
    const matches = await ctx.api.get(`/api/intelligence/search?runId=${encodeURIComponent(runId)}&q=${encodeURIComponent(search.value)}`, ctx.signal) as { items: Appearance[] };
    if (!active() || selectedRun !== runId) return; const filtered = matches.items.filter(a => !category.value || a.category === category.value); appearances.replaceChildren(...filtered.map(a => appearanceCard(a))); if (!filtered.length) appearances.append(el('p', '', 'No appearances for this filter.'));
  }
  async function refreshRun() {
    if (!active()) return;
    if (!selectedRun) { result = null; summary.textContent = 'No selected analysis run'; timeline.replaceChildren(); eventList.replaceChildren(); appearances.replaceChildren(); visits.replaceChildren(); facts.replaceChildren(); return; }
    const runId = selectedRun;
    const data = await ctx.api.get(`/api/intelligence/run?runId=${encodeURIComponent(runId)}`, ctx.signal) as { state: string; sourceChanged: boolean; error: string | null; result: TemporalResult | null };
    if (!active() || runId !== selectedRun) return;
    result = data.result; terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(data.state); summary.textContent = `${data.state}${data.sourceChanged ? ' · Source geometry changed since this run' : ''}`; if (data.error) status.textContent = data.error;
    const selected = runSelect.selectedOptions[0]; if (selected) selected.textContent = `${data.state} · ${runId.slice(0, 8)}`;
    if (result) status.textContent = 'Analysis accepted. Select an event to jump to its supporting footage.';
    if (!result) { timeline.replaceChildren(); eventList.replaceChildren(); appearances.replaceChildren(); visits.replaceChildren(); facts.replaceChildren(); return; }
    summary.textContent += ` · ${result.appearances.length} tracked appearances · ${result.events.filter(e => e.type === 'zone_entered').length} zone entries · ${result.coverage.observedMs.length} sampled frames · unique people unknown`;
    timeline.replaceChildren(); for (const event of result.events) { const marker = button(timestamp(event.positionMs), () => void guarded(() => playback(event)), `vi-marker vi-${event.type}`); marker.title = event.type; timeline.append(marker); }
    visits.replaceChildren(); for (const visit of result.visits) visits.append(el('p', 'vi-card', `${visit.appearanceId} · ${visit.zoneId} · ${visit.enteredMs === null ? 'Entry unknown' : 'In ' + timestamp(visit.enteredMs)} · ${visit.exitedMs === null ? 'Exit unknown' : 'Out ' + timestamp(visit.exitedMs)} · ${visit.state}`));
    await renderEvents();
    const dataSummary = await ctx.api.get(`/api/intelligence/summary?runId=${encodeURIComponent(runId)}`, ctx.signal) as { summary: string; categories: Record<string, { trackedAppearances: number; zoneEntries: number; possibleVisualGroups: number; reviewedEntities: number; unreviewedAppearances: number }> };
    if (!active() || selectedRun !== runId) return; facts.replaceChildren(el('p', '', dataSummary.summary)); for (const [category, count] of Object.entries(dataSummary.categories)) facts.append(el('p', '', `${category}: ${count.trackedAppearances} appearances · ${count.zoneEntries} entries · ${count.possibleVisualGroups} possible visual groups · ${count.reviewedEntities} reviewed anonymous entities · ${count.unreviewedAppearances} unreviewed`));
    await loadOperations();
  }
  async function loadOperations() {
    const [batchData, watchData, alertData, ruleData] = await Promise.all([ctx.api.get('/api/intelligence/batches', ctx.signal), ctx.api.get('/api/intelligence/watches', ctx.signal), ctx.api.get('/api/intelligence/alerts', ctx.signal),ctx.api.get('/api/intelligence/rules',ctx.signal)]) as [{ items: { batchId: string; items: { state: string }[] }[] }, { items: { id: string; prefix: string; active: boolean; processed: number; error: string | null }[] }, { items: { id: string; name: string; category: string; state: string; runId: string; eventId: string | null; positionMs: number }[] }, {items: {id:string;version:number;sourceId:string;name:string;category:string;type:string;zoneId:string;dwellMs:number;enabled:boolean}[]}];
    if (!active()) return; operational.replaceChildren(); for (const batch of batchData.items) { const row = el('article', 'vi-card'); row.append(el('p', '', `Batch ${batch.batchId.slice(0, 8)}: ${batch.items.filter(i => i.state === 'SUCCEEDED').length}/${batch.items.length} accepted`)); if (canWrite) row.append(button('Cancel batch', () => void guarded(async () => { await ctx.api.post('/api/intelligence/batches/cancel', { batchId: batch.batchId }, crypto.randomUUID(), ctx.signal); await loadOperations(); }))); operational.append(row); }
    for (const watch of watchData.items) { const row = el('article', 'vi-card'); row.append(el('p', '', `${watch.active ? 'Watching' : 'Stopped'} ${watch.prefix} · ${watch.processed} segments submitted${watch.error ? ' · ' + watch.error : ''}`)); if (canWrite && watch.active) row.append(button('Stop watch', () => void guarded(async () => { await ctx.api.post('/api/intelligence/watches/stop', { watchId: watch.id }, crypto.randomUUID(), ctx.signal); await loadOperations(); }))); operational.append(row); }
    ruleList.replaceChildren(); for(const rule of ruleData.items) { const card=el('article','vi-card');card.append(el('p','',rule.name+' · '+rule.type.replaceAll('_',' ')+' · '+(rule.enabled?'Enabled':'Disabled')));if(canWrite)card.append(button(rule.enabled?'Disable rule':'Enable rule',()=>void guarded(async()=>{const {id,version,...fields}=rule;await ctx.api.post('/api/intelligence/rules',{...fields,ruleId:id,version,enabled:!rule.enabled},crypto.randomUUID(),ctx.signal);await loadOperations();})));ruleList.append(card); }
    alerts.replaceChildren(); for (const alert of alertData.items) { const card = el('article', 'vi-card'); card.append(el('p', '', `${alert.name} · ${alert.category} · ${alert.state} · AI review required`)); card.append(button('Open alert footage', () => void guarded(async () => { await openRun(alert.runId); const data = await ctx.api.post('/api/intelligence/playback', { alertId: alert.id }, crypto.randomUUID(), ctx.signal) as { path: string; positionMs: number }; if (!active()) return; video.src = data.path; playbackGrant = undefined; video.addEventListener('loadedmetadata', () => { video.currentTime = data.positionMs / 1000; }, { once: true }); video.load(); }))); if (canWrite && alert.state === 'UNACKNOWLEDGED') card.append(button('Acknowledge alert', () => void guarded(async () => { await ctx.api.post('/api/intelligence/alerts/acknowledge', { alertId: alert.id }, crypto.randomUUID(), ctx.signal); await loadOperations(); }))); alerts.append(card); } if (!alertData.items.length) alerts.append(el('p', '', 'No accepted alerts.'));
  }
  sourceSelect.addEventListener('change', () => { selectedRun = ''; terminal = false; drawing = false; matches.replaceChildren(); canvas.style.pointerEvents = 'none'; currentRecording = sources.find(s => s.sourceId === sourceSelect.value); paint(); void guarded(async () => { await playback(); await loadRuns(); }); });
  runSelect.addEventListener('change', () => { selectedRun = runSelect.value; terminal = false; void guarded(refreshRun); });
  eventType.addEventListener('change', () => void guarded(renderEvents)); category.addEventListener('change', () => void guarded(renderEvents)); search.addEventListener('change', () => void guarded(renderEvents));
  const timer = setInterval(() => { if (!busy && !polling && active() && selectedRun && !result && !terminal) { polling = true; void refreshRun().catch(error => { if (active()) status.textContent = String(error); }).finally(() => { polling = false; }); } }, 4000);
  const operationsTimer = setInterval(() => { if (!busy && !polling && active()) { polling = true; void loadOperations().catch(error => { if (active()) status.textContent = String(error); }).finally(() => { polling = false; }); } }, 10000);
  void guarded(async () => { const capabilities = await ctx.api.get('/api/intelligence/capabilities', ctx.signal) as { advanced: boolean }; if (!active()) return; advanced.checked = capabilities.advanced; advanced.disabled = !capabilities.advanced; if (!capabilities.advanced) options.append(el('p', '', 'Advanced runtime not selected; CPU person analysis remains available.')); const data = await ctx.api.get('/api/intelligence/catalog', ctx.signal) as { items: RecordingView[] }; if (!active()) return; for (const item of data.items) { const option = el('option', '', item.name); option.value = item.id; catalogSelect.append(option); } if (!data.items.length) status.textContent = 'No local recordings admitted. Use the recording-admission tool.'; await loadSources(); await loadRuns(); await loadOperations(); });
  return () => { closed = true; clearInterval(timer); clearInterval(operationsTimer); video.pause(); video.removeAttribute('src'); video.load(); page.remove(); };
} };
