import type { Workspace, WorkspaceContext } from '@quadbridge/contracts';
import { button, el, emptyState, field, section } from '@quadbridge/web-shell/dom';
import type { AnalysisResult, AnalysisSample } from './protocol.js';
import type { SourceView } from '@quadbridge/veyviz-sources/protocol';

type JobState = 'QUEUED' | 'RUNNING' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED';
type ReviewState = 'OPEN' | 'REVIEWED' | 'DISMISSED';
interface AnalysisItem {
  id: string;
  jobId: string;
  sourceId: string;
  sourceVersion: number;
  jobState: JobState;
  reviewState: ReviewState;
  created: number;
  sampleCount: number;
  detectionCount: number;
  coverage: 'UNCOMMISSIONED_RECORDING' | 'UNKNOWN';
  occupancy: 'UNKNOWN';
  sourceChanged: boolean;
}
interface AnalysisList { items: AnalysisItem[]; limit: number }
interface ResultResponse {
  analysisId: string;
  jobState: JobState;
  reviewState: ReviewState;
  sourceId: string;
  sourceVersion: number;
  sourceChanged: boolean;
  result: AnalysisResult | null;
}
interface RunRow {
  element: HTMLLIElement;
  select: HTMLButtonElement;
  thumbnail: HTMLImageElement;
  thumbnailFallback: HTMLElement;
  reviewBadge: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  summary: HTMLElement;
  warning: HTMLElement;
  cancel: HTMLButtonElement | null;
}
interface LinkedController {
  signal: AbortSignal;
  abort(): void;
  dispose(): void;
}
const activeStates = new Set<JobState>(['QUEUED', 'RUNNING', 'CANCEL_REQUESTED']);
type WorkspaceMode = 'investigate' | 'command-center';

function setText(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}
function sourceName(sources: SourceView[], id: string) {
  return sources.find(source => source.id === id)?.name ?? 'Recording';
}
function formatDate(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';
}
function stateLabel(state: JobState) {
  switch (state) {
    case 'QUEUED': return 'Queued';
    case 'RUNNING': return 'Analyzing recorded frames';
    case 'CANCEL_REQUESTED': return 'Cancellation requested';
    case 'CANCELLED': return 'Cancelled';
    case 'SUCCEEDED': return 'Result ready';
    case 'FAILED': return 'Failed';
  }
}
function stateMessage(state: JobState) {
  switch (state) {
    case 'QUEUED': return 'This analysis is queued. No result has been accepted yet.';
    case 'RUNNING': return 'The worker is analyzing recorded frames.';
    case 'CANCEL_REQUESTED': return 'Cancellation was requested. The system is waiting for owned work to close.';
    case 'CANCELLED': return 'Analysis was cancelled. No result was accepted.';
    case 'FAILED': return 'Analysis failed before a result was accepted. Check local inference readiness before trying again.';
    case 'SUCCEEDED': return 'The job finished without an accepted sample result.';
  }
}
function linkedController(parent: AbortSignal): LinkedController {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    abort,
    dispose: () => parent.removeEventListener('abort', abort)
  };
}

export const workspace: Workspace = { mount(ctx) { return mountAnalysisWorkspace(ctx, 'investigate'); } };
export const commandCenter: Workspace = { mount(ctx) { return mountAnalysisWorkspace(ctx, 'command-center'); } };

function mountAnalysisWorkspace(ctx: WorkspaceContext, mode: WorkspaceMode): () => void {
  const commandCenterMode = mode === 'command-center';
  const canWrite = ctx.permissions.includes('veyviz.analysis.write');
  const root = ctx.root;
  root.classList.add(commandCenterMode ? 'veyviz-command' : 'veyviz-analysis');

  let sourceRecords: SourceView[] = [];
  let items: AnalysisItem[] = [];
  let selectedId: string | null = null;
  let selectedResult: AnalysisResult | null = null;
  let selectedResponse: ResultResponse | null = null;
  let selectedLoadedId: string | null = null;
  let selectedResultFailedId: string | null = null;
  let selectionEpoch = 0;
  let currentSample = 0;
  let sampleEpoch = 0;
  let sampleButtons: HTMLButtonElement[] = [];
  let closed = false;
  let listRequest: LinkedController | null = null;
  let resultRequest: LinkedController | null = null;
  let listEpoch = 0;
  let listBusy = false;
  let listQueued = false;
  let listLimit = 25;
  let loadingId: string | null = null;
  const previewCache = new Map<string, AnalysisResult>();
  const previewFailed = new Set<string>();
  const previewDecodeFailed = new Set<string>();
  const previewRequests = new Map<string, LinkedController>();
  const previewQueue: string[] = [];
  let previewWanted = new Set<string>();
  let pendingSubmission: { commandId: string; sourceId: string; frameCount: number; sampleStride: number } | null = null;
  const pendingReviews = new Map<string, { commandId: string; decision: ReviewState }>();
  const rows = new Map<string, RunRow>();
  const cancelBusy = new Set<string>();
  const pendingCancellations = new Map<string, string>();
  const reviewBusy = new Set<string>();

  const header = el('header', 'analysis-page-header');
  const headingCopy = el('div', 'analysis-heading-copy');
  headingCopy.append(
    el('p', 'analysis-eyebrow', commandCenterMode ? 'VEYVIZ  /  LOCAL REVIEW' : 'EVIDENCE WORKSPACE'),
    el('h1', '', commandCenterMode ? 'Command Center' : 'Investigate'),
    el('p', 'analysis-intro', commandCenterMode
      ? 'Review accepted frames and the work that needs attention.'
      : 'Search the latest analyses and inspect their accepted footage.')
  );
  header.append(headingCopy);
  const headerActions = el('div', 'analysis-header-actions');
  const summary = el('div', 'analysis-summary');
  const totalCount = el('strong', '', '0'), openCount = el('strong', '', '0'), activeCount = el('strong', '', '0');
  const metric = (label: string, value: HTMLElement) => {
    const node = el('div', 'analysis-metric');
    node.append(value, el('span', '', label));
    return node;
  };
  summary.setAttribute('aria-label', 'Current tenant analysis facts');
  summary.append(metric('latest analyses', totalCount), metric('open reviews', openCount), metric('active', activeCount));
  headerActions.append(summary);
  header.append(headerActions);

  const toolbar = el('div', 'analysis-toolbar');
  toolbar.classList.add(commandCenterMode ? 'command-toolbar' : 'investigate-toolbar');
  const readiness = el('div', 'analysis-readiness');
  const readinessMark = el('span', 'analysis-readiness-mark');
  const readinessText = el('span', '', 'Checking local inference readiness…');
  readiness.append(readinessMark, readinessText);
  const liveStatus = el('p', 'analysis-live-status');
  liveStatus.setAttribute('role', 'status');
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.setAttribute('aria-atomic', 'true');
  toolbar.append(readiness, liveStatus);

  const filterBar = el('section', 'analysis-filter-bar');
  filterBar.hidden = commandCenterMode;
  filterBar.setAttribute('aria-label', 'Filter latest analyses');
  const searchLabel = el('label', 'analysis-search-field');
  searchLabel.append(el('span', 'analysis-filter-label', 'Search latest analyses'));
  const searchInput = el('input');
  searchInput.type = 'search';
  searchInput.name = 'analysisSearch';
  searchInput.placeholder = 'Source name, status or analysis ID';
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-describedby', 'analysis-filter-scope');
  searchLabel.append(searchInput);
  const sourceFilterLabel = el('label', 'analysis-filter-select');
  sourceFilterLabel.append(el('span', 'analysis-filter-label', 'Recording'));
  const sourceFilter = el('select');
  sourceFilter.setAttribute('aria-label', 'Filter by recording');
  const allSourcesOption = el('option', '', 'All recordings');
  allSourcesOption.value = 'all';
  sourceFilter.append(allSourcesOption);
  sourceFilterLabel.append(sourceFilter);
  const stateFilterLabel = el('label', 'analysis-filter-select');
  stateFilterLabel.append(el('span', 'analysis-filter-label', 'State'));
  const stateFilter = el('select');
  stateFilter.setAttribute('aria-label', 'Filter by analysis state');
  for (const [value, label] of [['all', 'All states'], ['open', 'Open review'], ['ready', 'Result ready'], ['active', 'In progress'], ['failed', 'Failed']] as const) {
    const option = el('option', '', label); option.value = value; stateFilter.append(option);
  }
  stateFilterLabel.append(stateFilter);
  const dateFilterLabel = el('label', 'analysis-filter-select');
  dateFilterLabel.append(el('span', 'analysis-filter-label', 'Date'));
  const dateFilter = el('select');
  dateFilter.setAttribute('aria-label', 'Filter by creation date');
  for (const [value, label] of [['all', 'Any date'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']] as const) {
    const option = el('option', '', label); option.value = value; dateFilter.append(option);
  }
  dateFilterLabel.append(dateFilter);
  const clearFilters = button('Clear filters', () => {
    searchInput.value = '';
    sourceFilter.value = 'all';
    stateFilter.value = 'all';
    dateFilter.value = 'all';
    updateRows();
    schedulePreviewLoads();
  }, 'analysis-filter-clear');
  const filterScope = el('p', 'analysis-filter-scope', 'Filters match only the latest 25 analyses returned for this tenant.');
  filterScope.id = 'analysis-filter-scope';
  filterBar.append(searchLabel, sourceFilterLabel, stateFilterLabel, dateFilterLabel, clearFilters, filterScope);

  let setSubmitState = () => {};
  let sourceSelectRef: HTMLSelectElement | null = null;
  let sourceHelpRef: HTMLElement | null = null;
  let newRunDisclosure: HTMLDetailsElement | null = null;
  if (canWrite) {
    const disclosure = el('details', 'analysis-new-run');
    newRunDisclosure = disclosure;
    disclosure.append(el('summary', '', 'New analysis'));
    const form = el('form', 'analysis-form');
    const sourceField = el('label', 'analysis-source-field');
    sourceField.append(el('span', 'analysis-field-label', 'Recording'));
    const sourceSelect = el('select');
    sourceSelectRef = sourceSelect;
    sourceSelect.name = 'sourceId';
    sourceSelect.required = true;
    sourceSelect.setAttribute('aria-describedby', 'analysis-source-help');
    sourceField.append(sourceSelect);
    const sourceHelp = el('span', 'analysis-field-help');
    sourceHelp.id = 'analysis-source-help';
    sourceField.append(sourceHelp);
    sourceHelpRef = sourceHelp;

    const advanced = el('details', 'analysis-sampling-settings');
    advanced.append(el('summary', '', 'Sampling settings'));
    const frameCount = field('Sampled frames (1–6)', 'frameCount');
    const frameCountInput = frameCount.wrap.querySelector('input');
    if (frameCountInput) {
      frameCountInput.type = 'number';
      frameCountInput.min = '1';
      frameCountInput.max = '6';
      frameCountInput.value = '3';
    }
    const stride = field('Frame stride (1–30)', 'sampleStride');
    const strideInput = stride.wrap.querySelector('input');
    if (strideInput) {
      strideInput.type = 'number';
      strideInput.min = '1';
      strideInput.max = '30';
      strideInput.value = '10';
    }
    advanced.append(frameCount.wrap, stride.wrap);
    const submit = el('button', 'analysis-primary-action', 'Start analysis');
    submit.type = 'submit';
    const formFeedback = el('p', 'analysis-form-feedback');
    formFeedback.setAttribute('aria-live', 'polite');
    formFeedback.setAttribute('aria-atomic', 'true');
    form.append(sourceField, advanced, submit, formFeedback);
    disclosure.append(form);
    toolbar.append(disclosure);
    let submitting = false;
    setSubmitState = () => {
      submit.disabled = submitting || sourceRecords.length === 0 || !sourceSelect.value || ctx.signal.aborted;
    };
    sourceSelect.addEventListener('change', setSubmitState, { signal: ctx.signal });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (submitting || closed || ctx.signal.aborted || !sourceSelect.value) return;
      const requestBody = {
        sourceId: sourceSelect.value,
        frameCount: Number(frameCount.input.value),
        sampleStride: Number(stride.input.value)
      };
      if (!pendingSubmission || pendingSubmission.sourceId !== requestBody.sourceId ||
        pendingSubmission.frameCount !== requestBody.frameCount || pendingSubmission.sampleStride !== requestBody.sampleStride) {
        pendingSubmission = { commandId: crypto.randomUUID(), ...requestBody };
      }
      submitting = true;
      submit.disabled = true;
      setText(formFeedback, 'Queueing the selected recording…');
      void ctx.api.post('/api/analysis', requestBody, pendingSubmission.commandId, ctx.signal).then(async raw => {
        if (closed || ctx.signal.aborted) return;
        const queued = raw as { id?: unknown; state?: unknown };
        if (typeof queued.id !== 'string' || queued.state !== 'QUEUED') throw Error('The request did not return a queued analysis identity.');
        // A list read started before this committed command cannot replace its newer state.
        listEpoch++;
        selectedId = queued.id;
        selectedResult = null;
        selectedResponse = null;
        selectedLoadedId = null;
        selectedResultFailedId = null;
        pendingSubmission = null;
        searchInput.value = '';
        sourceFilter.value = 'all';
        stateFilter.value = 'all';
        dateFilter.value = 'all';
        selectionEpoch++;
        disclosure.open = false;
        setText(formFeedback, 'Analysis was queued. Its actual sampled results will appear when accepted.');
        setLive('Analysis queued. Worker state: queued.', true);
        updateSelectedPanel();
        if (document.activeElement === document.body || form.contains(document.activeElement)) selectedTitle.focus();
        await refresh();
      }).catch(error => {
        if (closed || ctx.signal.aborted) return;
        setText(formFeedback, error instanceof Error ? error.message : 'Analysis could not be queued.');
        setLive('Analysis could not be queued.', true);
      }).finally(() => {
        submitting = false;
        if (!closed && !ctx.signal.aborted) setSubmitState();
      });
    }, { signal: ctx.signal });
  }
  headerActions.append(toolbar);
  root.append(header, filterBar);

  const workbench = el('div', 'analysis-workbench');
  workbench.classList.add(commandCenterMode ? 'command-workbench' : 'investigate-workbench');
  const runsPanel = section('analysis-panel analysis-runs');
  const runHeading = el('div', 'analysis-panel-heading');
  const runHeadingTitle = el('h2', '', commandCenterMode ? 'Needs attention' : 'Results');
  const runCount = el('span', 'analysis-panel-count', '0');
  runHeading.append(runHeadingTitle, runCount);
  const runScope = el('p', 'analysis-run-scope', commandCenterMode
    ? 'Open reviews and active work in the latest 25 analyses.'
    : 'Latest 25 analyses · newest first');
  const runEmpty = emptyState(commandCenterMode ? 'Nothing needs attention' : 'No matching analyses', commandCenterMode
    ? 'There are no open reviews, active jobs or failed jobs in the latest 25 analyses.'
    : canWrite ? 'Register a recording, then start a new analysis to create your first review.' : 'No analyses match these filters in this tenant.');
  const runEmptyTitle = runEmpty.querySelector('h3');
  const runEmptyCopy = runEmpty.querySelector('p');
  const runList = el('ol', 'analysis-run-list');
  runList.classList.add(commandCenterMode ? 'analysis-queue-list' : 'analysis-result-grid');
  const cancelFeedback = el('p', 'analysis-inline-status');
  cancelFeedback.setAttribute('role', 'status');
  cancelFeedback.setAttribute('aria-live', 'polite');
  runsPanel.append(runHeading, runScope, runEmpty, runList, cancelFeedback);

  const reviewPanel = section('analysis-panel analysis-review-room');
  const selectedHeader = el('div', 'analysis-selected-heading');
  const selectedTitle = el('h2', '', 'Choose an analysis');
  selectedTitle.tabIndex = -1;
  const selectedState = el('span', 'analysis-job-state', 'No selection');
  selectedHeader.append(selectedTitle, selectedState);
  const selectedMeta = el('p', 'analysis-selected-meta', '');
  reviewPanel.append(selectedHeader, selectedMeta);
  const sourceWarning = el('p', 'analysis-source-warning');
  sourceWarning.hidden = true;
  reviewPanel.append(sourceWarning);

  const pendingState = el('div', 'analysis-state-card');
  pendingState.append(el('span', 'analysis-state-kicker', 'REVIEW STATUS'));
  const pendingTitle = el('h3', '', 'No saved result selected');
  const pendingCopy = el('p', '', 'Choose a saved analysis to inspect its sampled frames and observations.');
  const retryResult = button('Retry loading result', () => {
    if (!selectedId) return;
    selectedResult = null;
    selectedResponse = null;
    selectedLoadedId = null;
    selectedResultFailedId = null;
    loadingId = null;
    updateSelectedPanel();
    void loadSelectedResult(selectedId);
  }, 'analysis-secondary-action');
  retryResult.hidden = true;
  pendingState.append(pendingTitle, pendingCopy, retryResult);

  const resultView = el('div', 'analysis-result-view');
  resultView.hidden = true;
  const sampleSummary = el('div', 'analysis-sample-summary');
  const sampleLabel = el('p', 'analysis-sample-label');
  sampleLabel.setAttribute('aria-live', 'polite');
  sampleLabel.setAttribute('aria-atomic', 'true');
  const sampleClock = el('p', 'analysis-sample-clock');
  sampleSummary.append(sampleLabel, sampleClock);
  const imageRegion = el('figure', 'analysis-media-figure');
  const imageFrame = el('div', 'analysis-image-frame');
  const imageStatus = el('figcaption', 'analysis-image-status');
  imageStatus.setAttribute('role', 'status');
  imageStatus.setAttribute('aria-live', 'polite');
  imageStatus.setAttribute('aria-atomic', 'true');
  imageRegion.append(imageFrame, imageStatus);
  const sampleNav = el('div', 'analysis-sample-navigation');
  const previous = button('Previous sample', () => moveSample(-1), 'analysis-secondary-action');
  const samplePosition = el('span', 'analysis-sample-position');
  const next = button('Next sample', () => moveSample(1), 'analysis-secondary-action');
  sampleNav.append(previous, samplePosition, next);
  const filmstrip = el('nav', 'analysis-filmstrip');
  filmstrip.setAttribute('aria-label', 'Recorded samples');
  resultView.append(sampleSummary, imageRegion, sampleNav, filmstrip);
  reviewPanel.append(pendingState, resultView);

  const findingsPanel = section('analysis-panel analysis-findings');
  findingsPanel.append(el('p', 'analysis-eyebrow', 'MODEL OBSERVATIONS'));
  const findingsPlaceholder = el('div', 'analysis-findings-placeholder', 'Accepted detections will be described here.');
  const findingsView = el('div', 'analysis-findings-view');
  findingsView.hidden = true;
  const findingsHeader = el('div', 'analysis-findings-header');
  const findingsTitle = el('h2', '', 'Person detections');
  const findingsCount = el('span', 'analysis-findings-count', '0');
  findingsHeader.append(findingsTitle, findingsCount);
  const findingsNote = el('p', 'analysis-observation-note');
  const detections = el('ol', 'analysis-detection-list');
  const reviewCard = section('analysis-review-card');
  const reviewLabel = el('p', 'analysis-eyebrow', 'HUMAN REVIEW');
  const reviewState = el('p', 'analysis-review-state', 'Awaiting human review');
  const reviewNote = el('p', 'analysis-review-note', 'This records a human review decision for the selected analysis.');
  const reviewActions = el('div', 'analysis-review-actions');
  const markReviewed = button('Mark reviewed', () => void saveReview('REVIEWED'), 'analysis-primary-action');
  const dismiss = button('Dismiss result', () => void saveReview('DISMISSED'), 'analysis-secondary-action');
  if (canWrite) reviewActions.append(markReviewed, dismiss);
  else reviewActions.append(el('p', 'analysis-readonly-note', 'Read-only access. Review decisions cannot be changed by this account.'));
  reviewCard.append(reviewLabel, reviewState, reviewNote, reviewActions);
  reviewCard.hidden = true;
  resultView.append(reviewCard);
  const technical = el('details', 'analysis-technical');
  technical.append(el('summary', '', 'Analysis provenance'));
  const technicalFacts = el('dl', 'analysis-technical-facts');
  technical.append(technicalFacts);
  findingsView.append(findingsHeader, findingsNote, detections, technical);
  const sourceContext = section('analysis-source-context');
  sourceContext.hidden = true;
  sourceContext.append(el('p', 'analysis-eyebrow', 'RECORDING CONTEXT'));
  const sourceContextName = el('strong', 'analysis-source-context-name', 'No recording selected');
  const sourceContextFacts = el('dl', 'analysis-source-context-facts');
  sourceContext.append(sourceContextName, sourceContextFacts);
  findingsPanel.append(findingsPlaceholder, findingsView, sourceContext);
  if (commandCenterMode) {
    const commandRail = el('div', 'analysis-command-rail');
    commandRail.append(runsPanel, reviewCard, findingsPanel);
    workbench.append(reviewPanel, commandRail);
  } else {
    workbench.append(runsPanel, reviewPanel, findingsPanel);
  }
  root.append(workbench);

  function setLive(message: string, visible = false) {
    setText(liveStatus, message);
    liveStatus.classList.toggle('is-visible', visible);
  }
  function setRunCount(value: number) {
    setText(runCount, value + ' / ' + listLimit);
    runCount.setAttribute('aria-label', 'Showing ' + value + ' of the latest ' + listLimit + ' analyses');
    setText(runScope, commandCenterMode
      ? 'Open reviews and active or failed jobs · latest ' + listLimit
      : value + ' shown · filters apply to latest ' + listLimit);
  }
  function displayedItems(): AnalysisItem[] {
    if (commandCenterMode) {
      return items.filter(item =>
        (item.jobState === 'SUCCEEDED' && item.sampleCount > 0 && item.reviewState === 'OPEN') ||
        activeStates.has(item.jobState) || item.jobState === 'FAILED');
    }
    const query = searchInput.value.trim().toLocaleLowerCase();
    const sourceId = sourceFilter.value;
    const status = stateFilter.value;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dateValue = dateFilter.value;
    const after = dateValue === 'today' ? todayStart
      : dateValue === '7d' ? Date.now() - 7 * 24 * 60 * 60 * 1000
      : dateValue === '30d' ? Date.now() - 30 * 24 * 60 * 60 * 1000 : 0;
    return items.filter(item => {
      if (sourceId !== 'all' && item.sourceId !== sourceId) return false;
      if (status === 'open' && !(item.jobState === 'SUCCEEDED' && item.sampleCount > 0 && item.reviewState === 'OPEN')) return false;
      if (status === 'ready' && !(item.jobState === 'SUCCEEDED' && item.sampleCount > 0)) return false;
      if (status === 'active' && !activeStates.has(item.jobState)) return false;
      if (status === 'failed' && item.jobState !== 'FAILED') return false;
      if (after && item.created < after) return false;
      if (query) {
        const haystack = [sourceName(sourceRecords, item.sourceId), item.id, item.jobId, stateLabel(item.jobState), item.reviewState]
          .join(' ').toLocaleLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }
  function setCancelState(row: RunRow, item: AnalysisItem) {
    if (!row.cancel) return;
    const active = item.jobState === 'QUEUED' || item.jobState === 'RUNNING';
    if (!active && document.activeElement === row.cancel) row.select.focus();
    row.cancel.hidden = !active;
    row.cancel.disabled = cancelBusy.has(item.id) || ctx.signal.aborted;
    setText(row.cancel, cancelBusy.has(item.id) ? 'Requesting…' : 'Cancel');
    row.cancel.setAttribute('aria-label', 'Cancel analysis from ' + sourceName(sourceRecords, item.sourceId));
  }
  function createRow(item: AnalysisItem): RunRow {
    const element = el('li', 'analysis-run-row');
    const select = el('button', 'analysis-run-select');
    select.type = 'button';
    const media = el('span', 'analysis-run-media');
    const thumbnail = el('img', 'analysis-run-thumbnail');
    thumbnail.alt = '';
    thumbnail.loading = 'lazy';
    thumbnail.hidden = true;
    const thumbnailFallback = el('span', 'analysis-run-thumbnail-fallback', 'Loading frame');
    media.append(thumbnail, thumbnailFallback);
    const title = el('span', 'analysis-run-title');
    const meta = el('span', 'analysis-run-meta');
    const reviewBadge = el('span', 'analysis-run-review-badge');
    thumbnail.addEventListener('error', () => {
      const failedSource = thumbnail.dataset.previewSource;
      if (!failedSource || thumbnail.src !== failedSource) return;
      previewDecodeFailed.add(item.id);
      thumbnail.hidden = true;
      thumbnailFallback.hidden = false;
      setText(thumbnailFallback, 'Preview could not be decoded');
    }, { signal: ctx.signal });
    const summary = el('span', 'analysis-run-summary');
    const warning = el('span', 'analysis-run-warning', 'Source changed since this analysis was captured.');
    warning.hidden = true;
    const copy = el('span', 'analysis-run-copy');
    copy.append(title, meta, reviewBadge, summary, warning);
    select.append(media, copy);
    select.addEventListener('click', () => chooseRun(item.id), { signal: ctx.signal });
    let cancel: HTMLButtonElement | null = null;
    if (canWrite) {
      cancel = button('Cancel', () => void cancelRun(item.id), 'analysis-cancel-action');
      element.append(select, cancel);
    } else element.append(select);
    return { element, select, thumbnail, thumbnailFallback, reviewBadge, title, meta, summary, warning, cancel };
  }
  function updateSummary() {
    const awaiting = items.filter(item => item.jobState === 'SUCCEEDED' && item.sampleCount > 0 && item.reviewState === 'OPEN').length;
    const inProgress = items.filter(item => activeStates.has(item.jobState)).length;
    setText(totalCount, String(items.length));
    setText(openCount, String(awaiting));
    setText(activeCount, String(inProgress));
    setRunCount(displayedItems().length);
  }
  function updateRows() {
    const keep = new Set(items.map(item => item.id));
    const visible = displayedItems();
    const visibleIds = new Set(visible.map(item => item.id));
    for (const [id, row] of rows) {
      if (!keep.has(id)) {
        if (document.activeElement === row.select || document.activeElement === row.cancel) selectedTitle.focus();
        row.element.remove();
        rows.delete(id);
      } else if (!visibleIds.has(id) && row.element.parentElement === runList) {
        if (document.activeElement === row.select || document.activeElement === row.cancel) {
          if (!commandCenterMode && !filterBar.hidden) searchInput.focus(); else selectedTitle.focus();
        }
        row.element.remove();
      }
    }
    runEmpty.hidden = visible.length > 0;
    runList.hidden = visible.length === 0;
    if (!visible.length && runEmptyTitle && runEmptyCopy) {
      if (commandCenterMode) {
        setText(runEmptyTitle, 'Nothing needs attention');
        setText(runEmptyCopy, 'There are no open reviews, active jobs or failed jobs in the latest 25 analyses.');
      } else if (!items.length) {
        setText(runEmptyTitle, 'No analyses yet');
        setText(runEmptyCopy, canWrite ? 'Register a recording, then start a new analysis to create your first review.' : 'No analyses are available in this tenant.');
      } else {
        setText(runEmptyTitle, 'No matching analyses');
        setText(runEmptyCopy, 'Try clearing the filters. Search and filters cover only the latest ' + listLimit + ' analyses.');
      }
    }
    setRunCount(visible.length);
    for (let index = 0; index < visible.length; index++) {
      const item = visible[index];
      if (!item) continue;
      let row = rows.get(item.id);
      if (!row) {
        row = createRow(item);
        rows.set(item.id, row);
      }
      setText(row.title, sourceName(sourceRecords, item.sourceId));
      setText(row.meta, formatDate(item.created) + ' · ' + stateLabel(item.jobState));
      setText(row.summary, item.sampleCount > 0
        ? item.sampleCount + ' sampled frames · ' + item.detectionCount + ' model observations'
        : stateMessage(item.jobState));
      const hasReview = item.jobState === 'SUCCEEDED' && item.sampleCount > 0;
      row.reviewBadge.hidden = !hasReview;
      row.reviewBadge.className = 'analysis-run-review-badge review-badge-' + item.reviewState.toLowerCase();
      setText(row.reviewBadge, item.reviewState === 'OPEN' ? 'Open review'
        : item.reviewState === 'REVIEWED' ? 'Reviewed' : 'Dismissed');
      const preview = previewCache.get(item.id)?.samples[0];
      const previewUrl = preview?.thumbnailJpegBase64 ? 'data:image/jpeg;base64,' + preview.thumbnailJpegBase64 : '';
      const oldPreviewUrl = row.thumbnail.dataset.previewSource ?? '';
      if (oldPreviewUrl !== previewUrl) {
        previewDecodeFailed.delete(item.id);
        row.thumbnail.dataset.previewSource = previewUrl;
        row.thumbnail.removeAttribute('src');
        if (previewUrl) row.thumbnail.src = previewUrl;
      }
      const decodeFailed = previewDecodeFailed.has(item.id);
      const showPreview = Boolean(previewUrl) && !decodeFailed;
      row.thumbnail.hidden = !showPreview;
      row.thumbnailFallback.hidden = showPreview;
      setText(row.thumbnailFallback, decodeFailed ? 'Preview could not be decoded'
        : previewCache.has(item.id) ? 'No still provided'
        : previewFailed.has(item.id) ? 'Preview unavailable'
        : item.sampleCount === 0 ? 'No accepted frame'
        : loadingId === item.id || previewRequests.has(item.id) || previewQueue.includes(item.id) ? 'Loading preview'
        : 'Open to load sample');
      row.warning.hidden = !item.sourceChanged;
      row.select.setAttribute('aria-pressed', item.id === selectedId ? 'true' : 'false');
      row.select.setAttribute('aria-label', sourceName(sourceRecords, item.sourceId) + ', ' + stateLabel(item.jobState) +
        ', created ' + formatDate(item.created) + ', analysis ' + item.id.slice(0, 8) +
        (item.sampleCount > 0 ? ', ' + item.sampleCount + ' samples, ' + item.detectionCount + ' observations, ' + item.reviewState.toLowerCase() : ''));
      if (row.cancel) setCancelState(row, item);
      const existing = runList.children[index];
      if (existing !== row.element) runList.insertBefore(row.element, existing ?? null);
    }
  }
  function rememberPreview(id: string, result: AnalysisResult) {
    previewCache.delete(id);
    previewCache.set(id, result);
    while (previewCache.size > 8) {
      const oldest = previewCache.keys().next().value as string | undefined;
      if (!oldest) break;
      previewCache.delete(oldest);
    }
  }
  function pumpPreviewLoads() {
    if (closed || ctx.signal.aborted) return;
    while (previewRequests.size < 2 && previewQueue.length) {
      const id = previewQueue.shift();
      if (!id || !previewWanted.has(id) || previewCache.has(id) || previewFailed.has(id) || id === selectedId) continue;
      const request = linkedController(ctx.signal);
      previewRequests.set(id, request);
      void ctx.api.get('/api/analysis/result?analysisId=' + encodeURIComponent(id), request.signal).then(raw => {
        if (closed || request.signal.aborted || !previewWanted.has(id)) return;
        const response = raw as ResultResponse;
        if (response.analysisId === id && response.result) rememberPreview(id, response.result);
        else previewFailed.add(id);
      }).catch(() => {
        if (!closed && !request.signal.aborted) previewFailed.add(id);
      }).finally(() => {
        if (previewRequests.get(id) === request) previewRequests.delete(id);
        request.dispose();
        if (!closed && !ctx.signal.aborted) {
          updateRows();
          pumpPreviewLoads();
        }
      });
    }
  }
  function schedulePreviewLoads() {
    if (closed || ctx.signal.aborted) return;
    const candidates = displayedItems().filter(item => item.jobState === 'SUCCEEDED' && item.sampleCount > 0).slice(0, 8);
    previewWanted = new Set(candidates.map(item => item.id));
    for (let index = previewQueue.length - 1; index >= 0; index--) {
      const id = previewQueue[index];
      if (id && !previewWanted.has(id)) previewQueue.splice(index, 1);
    }
    for (const [id, request] of previewRequests) {
      if (!previewWanted.has(id)) request.abort();
    }
    for (const item of candidates) {
      if (item.id === selectedId || previewCache.has(item.id) || previewFailed.has(item.id) ||
        previewRequests.has(item.id) || previewQueue.includes(item.id)) continue;
      previewQueue.push(item.id);
    }
    pumpPreviewLoads();
  }
  function updateSelectedPanel() {
    const item = items.find(current => current.id === selectedId) ?? null;
    if (!item) {
      setText(selectedTitle, 'Choose an analysis');
      setText(selectedMeta, '');
      selectedState.className = 'analysis-job-state';
      setText(selectedState, 'No selection');
      sourceWarning.hidden = true;
      sourceContext.hidden = true;
      resultView.hidden = true;
      reviewCard.hidden = true;
      pendingState.hidden = false;
      findingsView.hidden = true;
      findingsPlaceholder.hidden = false;
      setText(pendingTitle, items.length ? 'Select a saved analysis' : 'No saved result yet');
      setText(pendingCopy, items.length
        ? 'Choose an analysis from the list to inspect its status and accepted samples.'
        : (canWrite ? 'Register a recording, then start a new analysis to create a review.' : 'No analyses are available in this tenant.'));
      retryResult.hidden = true;
      return;
    }
    setText(selectedTitle, sourceName(sourceRecords, item.sourceId) + ' · v' + item.sourceVersion);
    setText(selectedMeta, 'Started ' + formatDate(item.created) + ' · ' + item.sampleCount + ' accepted sample' + (item.sampleCount === 1 ? '' : 's'));
    selectedState.className = 'analysis-job-state state-' + item.jobState.toLowerCase().replaceAll('_', '-');
    setText(selectedState, stateLabel(item.jobState));
    sourceContext.hidden = false;
    const currentSource = sourceRecords.find(source => source.id === item.sourceId);
    setText(sourceContextName, sourceName(sourceRecords, item.sourceId));
    sourceContextFacts.replaceChildren();
    const sourceFacts: Array<[string, string]> = [
      ['Captured source version', 'v' + item.sourceVersion],
      ['Current version', currentSource ? 'v' + currentSource.version : 'Unavailable'],
      ['Input', 'Registered local recording']
    ];
    for (const [label, value] of sourceFacts) sourceContextFacts.append(el('dt', '', label), el('dd', '', value));
    const changed = item.sourceChanged || Boolean(selectedResponse?.sourceChanged);
    sourceWarning.hidden = !changed;
    setText(sourceWarning, 'Source changed since this analysis was submitted (captured version ' + item.sourceVersion + '). The accepted result remains tied to its original source identity.');
    if (selectedResult && selectedLoadedId === item.id) {
      pendingState.hidden = true;
      resultView.hidden = false;
      reviewCard.hidden = false;
      findingsPlaceholder.hidden = true;
      findingsView.hidden = false;
      retryResult.hidden = true;
      syncReviewPanel(item);
    } else {
      resultView.hidden = true;
      reviewCard.hidden = true;
      findingsView.hidden = true;
      findingsPlaceholder.hidden = false;
      pendingState.hidden = false;
      if (selectedResultFailedId === item.id) {
        setText(pendingTitle, 'Saved result unavailable');
        setText(pendingCopy, 'The result could not be loaded. Retry when the connection is available.');
        retryResult.hidden = false;
      } else {
        setText(pendingTitle, item.sampleCount > 0 ? 'Loading saved result' : stateLabel(item.jobState));
        setText(pendingCopy, item.sampleCount > 0 ? 'The accepted sample images and observations are being loaded.' : stateMessage(item.jobState));
        retryResult.hidden = true;
      }
    }
  }
  function syncReviewPanel(item: AnalysisItem) {
    const current = item.reviewState;
    setText(reviewState, current === 'OPEN' ? 'Awaiting human review' : current === 'REVIEWED' ? 'Reviewed' : 'Dismissed');
    reviewState.className = 'analysis-review-state review-' + current.toLowerCase();
    if (canWrite) {
      const busy = reviewBusy.has(item.id) || ctx.signal.aborted;
      markReviewed.disabled = busy;
      dismiss.disabled = busy;
      markReviewed.setAttribute('aria-pressed', current === 'REVIEWED' ? 'true' : 'false');
      dismiss.setAttribute('aria-pressed', current === 'DISMISSED' ? 'true' : 'false');
    }
  }
  function renderTechnical(result: AnalysisResult) {
    technicalFacts.replaceChildren();
    const facts: Array<[string, string]> = [
      ['Model profile', result.modelId],
      ['Decoded frames', String(result.decodedFrames)],
      ['Recording SHA-256', result.sourceSha256],
      ['Model SHA-256', result.modelSha256],
      ...Object.entries(result.versions).sort(([a], [b]) => a.localeCompare(b))
    ];
    for (const [label, value] of facts) {
      technicalFacts.append(el('dt', '', label), el('dd', 'analysis-hash', value));
    }
  }
  function renderDetectionList(sample: AnalysisSample) {
    detections.replaceChildren();
    detections.hidden = sample.detections.length === 0;
    setText(findingsCount, String(sample.detections.length));
    setText(findingsNote, sample.detections.length
      ? 'Model observations in this sampled frame. Confidence is a model score, not a verified identity.'
      : 'No person detections in this sampled frame. This does not establish absence from the recording.');
    if (!sample.detections.length) {
      detections.append(el('li', 'analysis-no-detections', 'No detections were returned for this frame.'));
      return;
    }
    sample.detections.forEach((detection, index) => {
      const entry = el('li', 'analysis-detection');
      const score = el('strong', '', Math.round(detection.confidence * 100) + '%');
      const dimensions = 'x ' + Math.round(detection.x1) + '–' + Math.round(detection.x2) + ', y ' +
        Math.round(detection.y1) + '–' + Math.round(detection.y2) + ' px';
      entry.append(score, el('span', '', 'Model observation ' + (index + 1) + ' · ' + dimensions));
      detections.append(entry);
    });
  }
  function showSample(index: number) {
    if (!selectedResult || index < 0 || index >= selectedResult.samples.length) return;
    currentSample = index;
    const sampleRenderEpoch = ++sampleEpoch;
    const resultAtRender = selectedResult;
    const renderedId = selectedId;
    const sample = selectedResult.samples[index];
    if (!sample) return;
    const count = selectedResult.samples.length;
    imageFrame.style.aspectRatio = Math.max(1, sample.width) + ' / ' + Math.max(1, sample.height);
    setText(sampleLabel, 'Sample ' + (index + 1) + ' of ' + count + ' · frame ' + sample.frameIndex);
    setText(sampleClock, sample.positionMs.toFixed(1) + ' ms from recording start');
    imageFrame.replaceChildren();
    imageStatus.classList.remove('analysis-image-error');
    imageStatus.hidden = false;
    setText(imageStatus, sample.thumbnailJpegBase64 ? 'Loading sample image…' : 'A preview image is not available for this accepted sample. Its metadata and observations remain available.');
    if (sample.thumbnailJpegBase64) {
      const image = el('img', 'analysis-frame-image');
      image.alt = 'Recorded frame ' + sample.frameIndex + ', sample ' + (index + 1) + ' of ' + count + ', at ' +
        sample.positionMs.toFixed(1) + ' milliseconds, with ' + sample.detections.length + ' person detections.';
      image.decoding = 'async';
      image.loading = 'eager';
      image.addEventListener('load', () => {
        if (closed || selectedId !== renderedId || selectedResult !== resultAtRender || sampleEpoch !== sampleRenderEpoch || currentSample !== index) return;
        imageStatus.hidden = true;
      }, { once: true, signal: ctx.signal });
      image.addEventListener('error', () => {
        if (closed || selectedId !== renderedId || selectedResult !== resultAtRender || sampleEpoch !== sampleRenderEpoch || currentSample !== index) return;
        imageStatus.hidden = false;
        imageStatus.classList.add('analysis-image-error');
        setText(imageStatus, 'This sampled image could not be decoded in the browser. Its accepted metadata and observations remain available.');
      }, { once: true, signal: ctx.signal });
      const overlay = el('div', 'analysis-box-layer');
      overlay.setAttribute('aria-hidden', 'true');
      const width = Math.max(1, sample.width), height = Math.max(1, sample.height);
      for (const detection of sample.detections) {
        const left = Math.min(100, Math.max(0, detection.x1 / width * 100));
        const top = Math.min(100, Math.max(0, detection.y1 / height * 100));
        const right = Math.min(100, Math.max(left, detection.x2 / width * 100));
        const bottom = Math.min(100, Math.max(top, detection.y2 / height * 100));
        const box = el('span', 'analysis-detection-box');
        box.style.left = left + '%';
        box.style.top = top + '%';
        box.style.width = (right - left) + '%';
        box.style.height = (bottom - top) + '%';
        box.append(el('span', '', Math.round(detection.confidence * 100) + '%'));
        overlay.append(box);
      }
      imageFrame.append(image, overlay);
      image.src = 'data:image/jpeg;base64,' + sample.thumbnailJpegBase64;
    }
    sampleButtons.forEach((control, buttonIndex) => {
      control.setAttribute('aria-pressed', buttonIndex === index ? 'true' : 'false');
      control.classList.toggle('is-current', buttonIndex === index);
    });
    setText(samplePosition, (index + 1) + ' / ' + count);
    previous.disabled = index === 0;
    next.disabled = index === count - 1;
    renderDetectionList(sample);
  }
  function moveSample(delta: number) {
    if (!selectedResult) return;
    showSample(currentSample + delta);
  }
  function renderAcceptedResult(result: AnalysisResult, analysisId: string) {
    selectedResult = result;
    selectedLoadedId = analysisId;
    rememberPreview(analysisId, result);
    previewFailed.delete(analysisId);
    currentSample = 0;
    sampleButtons = [];
    filmstrip.replaceChildren();
    result.samples.forEach((sample, index) => {
      const accessibleName = 'Sample ' + (index + 1) + ', frame ' + sample.frameIndex + ', ' +
        sample.positionMs.toFixed(1) + ' milliseconds, ' + sample.detections.length + ' person detections';
      const tab = button(accessibleName, () => showSample(index), 'analysis-filmstrip-item');
      tab.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
      tab.setAttribute('aria-label', accessibleName);
      tab.classList.toggle('is-current', index === 0);
      tab.replaceChildren(el('span', 'analysis-filmstrip-number', String(index + 1).padStart(2, '0')),
        el('span', 'analysis-filmstrip-facts', 'Frame ' + sample.frameIndex + ' · ' + sample.detections.length + ' detections'));
      if (sample.thumbnailJpegBase64) {
        const thumbnail = el('img', 'analysis-filmstrip-thumbnail');
        thumbnail.alt = '';
        thumbnail.decoding = 'async';
        thumbnail.addEventListener('error', () => thumbnail.remove(), { once: true, signal: ctx.signal });
        thumbnail.src = 'data:image/jpeg;base64,' + sample.thumbnailJpegBase64;
        tab.prepend(thumbnail);
      }
      filmstrip.append(tab);
      sampleButtons.push(tab);
    });
    renderTechnical(result);
    selectedResultFailedId = null;
    updateSelectedPanel();
    updateRows();
    showSample(0);
    schedulePreviewLoads();
  }
  function loadSelectedResult(id: string) {
    const item = items.find(current => current.id === id);
    if (!item || item.sampleCount === 0 || closed || ctx.signal.aborted || loadingId === id) return;
    if (selectedLoadedId === id && selectedResult) return;
    const cached = previewCache.get(id);
    if (cached) {
      selectedResponse = null;
      selectedResultFailedId = null;
      renderAcceptedResult(cached, id);
      setLive('Accepted result loaded with ' + cached.samples.length + ' sampled frames.');
      return;
    }
    resultRequest?.abort();
    resultRequest?.dispose();
    loadingId = null;
    const request = linkedController(ctx.signal);
    resultRequest = request;
    const epoch = selectionEpoch;
    loadingId = id;
    setLive('Loading the accepted sample result.');
    void ctx.api.get('/api/analysis/result?analysisId=' + encodeURIComponent(id), request.signal).then(raw => {
      if (closed || request.signal.aborted || selectedId !== id || selectionEpoch !== epoch) return;
      const response = raw as ResultResponse;
      selectedResponse = response;
      selectedResultFailedId = null;
      if (!response.result) {
        selectedResult = null;
        selectedLoadedId = null;
        selectedResultFailedId = id;
        updateSelectedPanel();
        setText(pendingCopy, 'No accepted sample result is available for this analysis. Retry to check again.');
        return;
      }
      rememberPreview(id, response.result);
      renderAcceptedResult(response.result, id);
      setLive('Accepted result loaded with ' + response.result.samples.length + ' sampled frames.');
    }).catch(error => {
      if (closed || request.signal.aborted || selectedId !== id || selectionEpoch !== epoch) return;
      selectedResultFailedId = id;
      updateSelectedPanel();
      setText(pendingCopy, error instanceof Error ? error.message : 'Saved result could not be loaded.');
      setLive('The accepted result could not be loaded. Retry from the selected analysis.', true);
    }).finally(() => {
      if (resultRequest === request) {
        resultRequest = null;
        if (loadingId === id) loadingId = null;
        request.dispose();
      }
    });
  }
  function chooseRun(id: string) {
    if (closed || id === selectedId) return;
    selectedId = id;
    selectedResult = null;
    selectedResponse = null;
    selectedLoadedId = null;
    selectedResultFailedId = null;
    selectionEpoch++;
    resultRequest?.abort();
    resultRequest?.dispose();
    resultRequest = null;
    loadingId = null;
    updateRows();
    updateSelectedPanel();
    const item = items.find(current => current.id === id);
    schedulePreviewLoads();
    if (item?.sampleCount) loadSelectedResult(id);
    else setLive(item ? stateLabel(item.jobState) + '. ' + stateMessage(item.jobState) : 'Analysis selected.', Boolean(item));
  }
  function saveReview(decision: ReviewState) {
    const id = selectedId;
    if (!canWrite || !id || closed || ctx.signal.aborted || reviewBusy.has(id)) return;
    const item = items.find(current => current.id === id);
    if (!item || item.jobState !== 'SUCCEEDED' || item.sampleCount === 0) return;
    const focusedAction = document.activeElement === markReviewed ? markReviewed : document.activeElement === dismiss ? dismiss : null;
    reviewBusy.add(id);
    syncReviewPanel(item);
    setLive('Saving review decision…', true);
    let intent = pendingReviews.get(id);
    if (!intent || intent.decision !== decision) {
      intent = { commandId: crypto.randomUUID(), decision };
      pendingReviews.set(id, intent);
    }
    void ctx.api.post('/api/analysis/review', { analysisId: id, decision }, intent.commandId, ctx.signal).then(raw => {
      if (closed || ctx.signal.aborted) return;
      const result = raw as { decision?: ReviewState };
      const saved = result.decision === 'REVIEWED' || result.decision === 'DISMISSED' ? result.decision : decision;
      listEpoch++;
      pendingReviews.delete(id);
      items = items.map(current => current.id === id ? { ...current, reviewState: saved } : current);
      updateSummary();
      updateRows();
      const selected = items.find(current => current.id === selectedId);
      if (selected) syncReviewPanel(selected);
      setLive('Review decision saved: ' + (saved === 'REVIEWED' ? 'Reviewed.' : 'Dismissed.'), true);
      void refresh();
    }).catch(error => {
      if (!closed && !ctx.signal.aborted) {
        setLive('Review decision could not be saved.', true);
        ctx.notice(error instanceof Error ? error.message : 'Review decision could not be saved.');
      }
    }).finally(() => {
      reviewBusy.delete(id);
      const selected = items.find(current => current.id === selectedId);
      if (selected) syncReviewPanel(selected);
      if (!closed && !ctx.signal.aborted && selectedId === id && focusedAction && document.activeElement === document.body) focusedAction.focus();
    });
  }
  function cancelRun(id: string) {
    if (!canWrite || closed || ctx.signal.aborted || cancelBusy.has(id)) return;
    const item = items.find(current => current.id === id);
    if (!item || (item.jobState !== 'QUEUED' && item.jobState !== 'RUNNING')) return;
    cancelBusy.add(id);
    updateRows();
    setText(cancelFeedback, 'Cancellation requested. The worker still needs to report its final state.');
    let commandId = pendingCancellations.get(id);
    if (!commandId) {
      commandId = crypto.randomUUID();
      pendingCancellations.set(id, commandId);
    }
    void ctx.api.post('/api/analysis/cancel', { analysisId: id }, commandId, ctx.signal).then(() => {
      if (closed || ctx.signal.aborted) return;
      pendingCancellations.delete(id);
      listEpoch++;
      setLive('Cancellation request recorded. Owned work closure is still pending.', true);
      void refresh();
    }).catch(error => {
      if (!closed && !ctx.signal.aborted) {
        setText(cancelFeedback, error instanceof Error ? error.message : 'Cancellation could not be requested.');
        ctx.notice(error instanceof Error ? error.message : 'Cancellation could not be requested.');
      }
    }).finally(() => {
      cancelBusy.delete(id);
      if (!closed) updateRows();
    });
  }
  async function refresh() {
    if (listBusy) {
      listQueued = true;
      return;
    }
    listBusy = true;
    const request = linkedController(ctx.signal);
    listRequest = request;
    const epoch = ++listEpoch;
    try {
      const raw = await ctx.api.get('/api/analysis', request.signal);
      if (closed || request.signal.aborted || epoch !== listEpoch) return;
      const response = raw as AnalysisList;
      if (!Array.isArray(response.items)) throw Error('The analysis list response is invalid.');
      const previous = new Map(items.map(item => [item.id, item.jobState]));
      items = response.items;
      listLimit = Number.isSafeInteger(response.limit) && response.limit > 0 ? response.limit : 25;
      updateSummary();
      updateRows();
      if (!selectedId) {
        const newest = (commandCenterMode
          ? items.find(item => item.jobState === 'SUCCEEDED' && item.sampleCount > 0 && item.reviewState === 'OPEN')
          : undefined) ?? items.find(item => item.jobState === 'SUCCEEDED' && item.sampleCount > 0) ?? items[0];
        if (newest) {
          selectedId = newest.id;
          selectionEpoch++;
          updateRows();
        }
      }
      if (!items.length && newRunDisclosure) newRunDisclosure.open = true;
      updateSelectedPanel();
      const selected = items.find(item => item.id === selectedId);
      if (selected?.sampleCount && !selectedResult && selectedResultFailedId !== selected.id) loadSelectedResult(selected.id);
      schedulePreviewLoads();
      for (const item of items) {
        const old = previous.get(item.id);
        if (old && old !== item.jobState && item.id === selectedId) {
          setLive(sourceName(sourceRecords, item.sourceId) + ' analysis is now ' + stateLabel(item.jobState).toLowerCase() + '.', true);
        }
      }
    } catch (error) {
      if (!closed && !request.signal.aborted && epoch === listEpoch) {
        if (!items.length) {
          setText(pendingTitle, 'Analysis history unavailable');
          setText(pendingCopy, error instanceof Error ? error.message : 'Analysis history could not be loaded.');
        }
        setLive('Analysis history could not be refreshed. The last saved view remains available.', true);
      }
    } finally {
      if (listRequest === request) {
        listRequest = null;
        request.dispose();
      }
      listBusy = false;
      if (listQueued && !closed && !ctx.signal.aborted) {
        listQueued = false;
        queueMicrotask(() => void refresh());
      }
    }
  }
  async function loadSources() {
    try {
      const raw = await ctx.api.get('/api/analysis/sources', ctx.signal);
      if (closed || ctx.signal.aborted) return;
      const response = raw as { items: SourceView[] };
      sourceRecords = Array.isArray(response.items) ? response.items : [];
      const selectedFilter = sourceFilter.value || 'all';
      sourceFilter.replaceChildren();
      const allSources = el('option', '', 'All recordings');
      allSources.value = 'all';
      sourceFilter.append(allSources);
      for (const source of sourceRecords) {
        const option = el('option', '', source.name);
        option.value = source.id;
        sourceFilter.append(option);
      }
      sourceFilter.value = sourceRecords.some(source => source.id === selectedFilter) ? selectedFilter : 'all';
      if (canWrite) setSubmitState();
      updateRows();
      updateSelectedPanel();
      const select = sourceSelectRef;
      if (canWrite && select) {
        const old = select.value;
        select.replaceChildren();
        if (!sourceRecords.length) {
          const option = el('option', '', 'No recording is registered');
          option.value = '';
          select.append(option);
          if (sourceHelpRef) setText(sourceHelpRef, 'Register the supported local sample in Recordings first.');
        } else {
          const firstSource = sourceRecords[0];
          if (!firstSource) return;
          for (const source of sourceRecords) {
            const option = el('option', '', source.name + ' · v' + source.version);
            option.value = source.id;
            select.append(option);
          }
          select.value = sourceRecords.some(source => source.id === old) ? old : firstSource.id;
          if (sourceHelpRef) setText(sourceHelpRef, 'Only recordings registered in this tenant are available.');
        }
        setSubmitState();
      }
    } catch (error) {
      if (!closed && !ctx.signal.aborted) {
        setLive('Recording list unavailable. Analysis history remains readable.', true);
        ctx.notice(error instanceof Error ? error.message : 'Recording list could not be loaded.');
      }
    }
  }
  async function loadReadiness() {
    try {
      const raw = await ctx.api.get('/api/analysis/readiness', ctx.signal);
      if (closed || ctx.signal.aborted) return;
      const state = raw as { status: string; profileId: string; message: string };
      const ready = state.status === 'READY';
      readinessMark.classList.toggle('is-ready', ready);
      readinessMark.classList.toggle('is-unavailable', !ready);
      setText(readinessText, ready ? 'Local analysis ready' : 'Analysis unavailable · ' + state.message);
    } catch {
      if (!closed && !ctx.signal.aborted) {
        readinessMark.classList.add('is-unavailable');
        setText(readinessText, 'Local inference readiness could not be checked.');
      }
    }
  }

  const refreshFilters = () => {
    updateRows();
    schedulePreviewLoads();
  };
  searchInput.addEventListener('input', refreshFilters, { signal: ctx.signal });
  sourceFilter.addEventListener('change', refreshFilters, { signal: ctx.signal });
  stateFilter.addEventListener('change', refreshFilters, { signal: ctx.signal });
  dateFilter.addEventListener('change', refreshFilters, { signal: ctx.signal });

  function moveToSampleFromKey(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    moveSample(event.key === 'ArrowLeft' ? -1 : 1);
  }
  imageRegion.tabIndex = 0;
  imageRegion.setAttribute('role', 'group');
  imageRegion.setAttribute('aria-label', 'Sample image. Use the Previous and Next sample buttons, or arrow keys while this area is focused.');
  imageRegion.addEventListener('keydown', moveToSampleFromKey, { signal: ctx.signal });
  if (!canWrite) root.insertBefore(el('p', 'analysis-readonly-note', 'Read-only access. You can inspect saved analyses and review decisions.'), workbench);

  void Promise.all([loadSources(), loadReadiness(), refresh()]);
  const timer = setInterval(() => { if (!closed) void refresh(); }, 1500);
  return () => {
    closed = true;
    clearInterval(timer);
    listEpoch++;
    listRequest?.abort();
    listRequest?.dispose();
    resultRequest?.abort();
    resultRequest?.dispose();
    for (const request of previewRequests.values()) { request.abort(); request.dispose(); }
    previewRequests.clear();
    previewQueue.length = 0;
    root.classList.remove(commandCenterMode ? 'veyviz-command' : 'veyviz-analysis');
  };
}
