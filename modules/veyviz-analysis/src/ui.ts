import type { Workspace } from '@quadbridge/contracts';
import { button, el, emptyState, field, heading, section, statistic } from '@quadbridge/web-shell/dom';
import type { AnalysisResult } from './protocol.js';
import type { SourceView } from '@quadbridge/veyviz-sources/protocol';

interface AnalysisItem {
  id: string; jobId: string; sourceId: string; sourceVersion: number;
  jobState: 'QUEUED' | 'RUNNING' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED';
  reviewState: 'OPEN' | 'REVIEWED' | 'DISMISSED'; created: number; sampleCount: number; detectionCount: number;
  coverage: 'UNCOMMISSIONED_RECORDING' | 'UNKNOWN'; occupancy: 'UNKNOWN'; sourceChanged: boolean;
}
interface ResultResponse { analysisId: string; jobState: AnalysisItem['jobState']; reviewState: AnalysisItem['reviewState']; sourceId: string; sourceVersion: number; sourceChanged: boolean; result: AnalysisResult | null }
const activeStates = new Set(['QUEUED', 'RUNNING', 'CANCEL_REQUESTED']);

function renderSamples(root: HTMLElement, result: AnalysisResult) {
  root.replaceChildren();
  root.append(el('p', 'small muted', `${result.samples.length} sampled frame${result.samples.length === 1 ? '' : 's'} · source position is recording time · occupancy UNKNOWN`));
  result.samples.forEach((sample, index) => {
    const card = section('list-item analysis-sample');
    card.append(el('div', 'item-meta', `Sample ${index + 1} · frame ${sample.frameIndex} · ${sample.positionMs.toFixed(1)} ms · inference ${sample.inferenceMs.toFixed(1)} ms`));
    card.append(el('p', 'small muted', `${sample.detections.length} observed person detection${sample.detections.length === 1 ? '' : 's'} · ${sample.width}×${sample.height} · uncommissioned footage`));
    if (sample.thumbnailJpegBase64) {
      const image = new Image(); image.alt = `Recorded frame ${sample.frameIndex} with model detection boxes`;
      image.src = `data:image/jpeg;base64,${sample.thumbnailJpegBase64}`;
      const canvas = el('canvas', 'analysis-frame'), stage = el('div', 'analysis-visual');
      const draw = () => {
        const scale = Math.min(1, 640 / Math.max(sample.width, sample.height));
        canvas.width = Math.max(1, Math.floor(sample.width * scale)); canvas.height = Math.max(1, Math.floor(sample.height * scale));
        const context = canvas.getContext('2d'); if (!context) return;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        context.lineWidth = Math.max(2, canvas.width / 320); context.strokeStyle = '#ffce70'; context.fillStyle = '#ffce70';
        for (const detection of sample.detections) {
          const x = detection.x1 * scale, y = detection.y1 * scale, w = (detection.x2 - detection.x1) * scale, h = (detection.y2 - detection.y1) * scale;
          context.strokeRect(x, y, w, h); context.font = `${Math.max(12, canvas.width / 45)}px sans-serif`;
          context.fillText(`${Math.round(detection.confidence * 100)}%`, x + 3, Math.max(13, y - 3));
        }
      };
      image.addEventListener('load', draw, { once: true, signal: new AbortController().signal });
      if (image.complete) draw();
      stage.append(canvas); card.append(stage);
    } else card.append(el('p', 'small muted', 'A bounded JPEG thumbnail is unavailable for this frame.'));
    root.append(card);
  });
  root.append(el('p', 'small muted', `Model ${result.modelId} · source SHA-256 ${result.sourceSha256} · model SHA-256 ${result.modelSha256}`));
  root.append(el('p', 'small muted', `Coverage ${result.coverage}; occupancy ${result.occupancy}. Detection counts are model observations only.`));
}

export const workspace: Workspace = { mount(ctx) {
  const canWrite = ctx.permissions.includes('veyviz.analysis.write');
  ctx.root.classList.add('veyviz-analysis');
  ctx.root.append(heading('Video analysis', 'Run bounded local CPU inference on an authorized recording and review the typed observations. No live-camera, occupancy or absence claim is made.'));
  const stats = el('div', 'stat-grid'); ctx.root.append(stats);
  const grid = el('div', 'grid'), submitCard = section(), activity = section(); grid.append(submitCard, activity); ctx.root.append(grid);
  submitCard.append(el('h3', '', 'Analyze a recording'));
  const readiness = el('p', 'small muted', 'Checking the configured local inference profile…'); submitCard.append(readiness);
  const form = el('form'), sourceSelect = el('select'), sourceLabel = el('label', 'field');
  sourceLabel.append(el('span', 'field-label', 'Registered source'), sourceSelect);
  const frameCount = field('Sampled frames (1–6)', 'frameCount'), sampleStride = field('Frame stride (1–30)', 'sampleStride');
  frameCount.input.setAttribute('type', 'number'); frameCount.input.setAttribute('min', '1'); frameCount.input.setAttribute('max', '6'); frameCount.input.value = '3';
  sampleStride.input.setAttribute('type', 'number'); sampleStride.input.setAttribute('min', '1'); sampleStride.input.setAttribute('max', '30'); sampleStride.input.value = '10';
  form.append(sourceLabel, frameCount.wrap, sampleStride.wrap);
  const submit = el('button', 'button', 'Queue recorded analysis'); submit.type = 'submit'; submit.disabled = !canWrite; form.append(submit); submitCard.append(form);
  sourceSelect.disabled = !canWrite; frameCount.input.disabled = !canWrite; sampleStride.input.disabled = !canWrite;
  const formNote = el('p', 'small muted', canWrite ? 'The source version and original actor, tenant, instance and command are captured when the request is queued.' : 'Read-only access. You can inspect analysis results, but this account cannot start, cancel, or review analyses.'); submitCard.append(formNote);
  const list = el('div'); activity.append(el('h3', '', 'Analysis history'), list); const detail = section(); detail.hidden = true; ctx.root.append(detail);
  let sourceRecords: SourceView[] = [], closed = false, busy = false;
  async function loadSources() {
    const response = await ctx.api.get('/api/analysis/sources') as { items: SourceView[] };
    if (closed || ctx.signal.aborted) return;
    sourceRecords = response.items;
    const oldValue = sourceSelect.value;
    sourceSelect.replaceChildren();
    if (!sourceRecords.length) {
      const option = el('option', '', 'Register a source in Recordings first'); option.value = ''; sourceSelect.append(option); submit.disabled = true;
    } else {
      for (const source of sourceRecords) { const option = el('option', '', `${source.name} · v${source.version}`); option.value = source.id; option.selected = source.id === oldValue; sourceSelect.append(option); }
      submit.disabled = !canWrite;
    }
  }
  async function loadReadiness() {
    const state = await ctx.api.get('/api/analysis/readiness') as { status: string; profileId: string; message: string; modelSha256?: string };
    if (closed || ctx.signal.aborted) return;
    readiness.textContent = state.status === 'READY' ? `Ready · ${state.profileId} · model ${state.modelSha256?.slice(0, 12)}…` : `Inference unavailable · ${state.message}`;
    readiness.className = state.status === 'READY' ? 'small success' : 'small muted';
  }
  async function showResult(id: string) {
    detail.hidden = false; detail.replaceChildren(el('h3', '', 'Accepted model result'), el('p', 'small muted', 'Loading saved result…'));
    try {
      const response = await ctx.api.get(`/api/analysis/result?analysisId=${encodeURIComponent(id)}`) as ResultResponse;
      if (closed || ctx.signal.aborted) return;
      detail.replaceChildren(el('h3', '', 'Accepted model result'));
      if (!response.result) { detail.append(el('p', 'muted', `No Product result was accepted. Worker state: ${response.jobState}.`)); return; }
      if (response.sourceChanged) detail.append(el('p', 'error', `The registered source changed after submission (captured v${response.sourceVersion}). This accepted result remains visible with its original source identity.`));
      renderSamples(detail, response.result);
      const review = el('div', 'analysis-review'); review.append(el('p', 'small muted', `Human review state: ${response.reviewState}. A review records a person's assessment of these observations; it does not prove occupancy.`));
      if (canWrite) {
        for (const decision of ['REVIEWED', 'DISMISSED'] as const) {
          const action = button(decision === 'REVIEWED' ? 'Mark reviewed' : 'Dismiss result', () => void ctx.api.post('/api/analysis/review', { analysisId: id, decision }).then(() => showResult(id)).catch(error => ctx.notice(error instanceof Error ? error.message : 'Review state could not be saved')));
          review.append(action);
        }
      } else review.append(el('p', 'small muted', 'Read-only access. Review state cannot be changed by this account.'));
      detail.append(review);
    } catch (error) { if (!closed && !ctx.signal.aborted) detail.replaceChildren(el('h3', '', 'Result unavailable'), el('p', 'error', error instanceof Error ? error.message : 'Saved result could not be loaded')); }
  }
  async function refresh() {
    const response = await ctx.api.get('/api/analysis') as { items: AnalysisItem[]; limit: number };
    if (closed || ctx.signal.aborted) return;
    const items = response.items;
    stats.replaceChildren(statistic('Requests retained', items.length, `Latest ${response.limit}`), statistic('Ready for review', items.filter(item => item.jobState === 'SUCCEEDED' && item.sampleCount > 0).length, 'Accepted typed results'), statistic('Running or queued', items.filter(item => activeStates.has(item.jobState)).length, 'Worker lifecycle state'));
    list.replaceChildren();
    if (!items.length) { list.append(emptyState('No analyses yet', 'Choose a registered recording and queue an analysis.')); return; }
    for (const item of items) {
      const card = el('article', 'list-item'), meta = el('div', 'item-meta', `${item.jobState} · source v${item.sourceVersion} · ${item.reviewState}`);
      card.append(meta, el('h4', '', sourceRecords.find(source => source.id === item.sourceId)?.name ?? `Source ${item.sourceId}`),
        el('p', 'small muted', item.sampleCount ? `${item.sampleCount} sampled frames · ${item.detectionCount} model observations · occupancy UNKNOWN` : 'No accepted result yet.'));
      if (item.sourceChanged) card.append(el('p', 'error', 'The source changed since this request was captured.'));
      if (item.jobState === 'FAILED') card.append(el('p', 'error', 'Inference did not complete. Inspect local profile readiness and runner status.'));
      if (item.jobState === 'CANCEL_REQUESTED') card.append(el('p', 'small muted', 'Cancellation was requested; waiting for worker and native process closure.'));
      if (item.sampleCount) card.append(button('Open saved result', () => void showResult(item.id)));
      if (canWrite && (item.jobState === 'QUEUED' || item.jobState === 'RUNNING')) card.append(button('Cancel analysis', () => void ctx.api.post('/api/analysis/cancel', { analysisId: item.id }).then(refresh).catch(error => ctx.notice(error instanceof Error ? error.message : 'Cancellation could not be requested'))));
      list.append(card);
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!canWrite || busy || closed || !sourceSelect.value) return;
    busy = true; submit.disabled = true;
    void ctx.api.post('/api/analysis', { sourceId: sourceSelect.value, frameCount: Number(frameCount.input.value), sampleStride: Number(sampleStride.input.value) })
      .then(async () => { formNote.textContent = 'Analysis was queued with the current authorized source and actor scope.'; await refresh(); })
      .catch(error => { formNote.textContent = error instanceof Error ? error.message : 'Analysis could not be queued'; })
      .finally(() => { busy = false; if (!closed) submit.disabled = !canWrite || sourceRecords.length === 0; });
  }, { signal: ctx.signal });
  void Promise.all([loadSources(), loadReadiness(), refresh()]).catch(error => ctx.notice(error instanceof Error ? error.message : 'Analysis workspace could not load'));
  const timer = setInterval(() => { if (!closed) void refresh().catch(error => { if (!closed) ctx.notice(error instanceof Error ? error.message : 'Analysis history unavailable'); }); }, 1500);
  return () => { closed = true; clearInterval(timer); ctx.root.classList.remove('veyviz-analysis'); };
} };
