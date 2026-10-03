import type { Workspace } from '@quadbridge/contracts';
import { createCommandState, type CapturedCommandIntent } from '@quadbridge/client-core';
import { actionButton, el, fieldControl, heading, section, statistic, emptyState, statusNotice } from '@quadbridge/ui/components';

const labels: Record<string, string> = {
  DESTINATION_COMMITTED: 'Destination confirmed', ACCEPTANCE_UNKNOWN: 'Confirmation needed', QUEUED: 'Waiting to send',
  FAILED: 'Local attempt failed', SUCCEEDED: 'Local completion recorded', CANCELLED: 'Local attempt cancelled',
  NOT_SENT: 'Not sent', RECONCILIATION_REQUIRED: 'Earlier-protocol review required'
};

type HandoffItem = {
  id: string;
  title: string;
  outcome: string;
  state: string;
  target_ref: unknown;
  delivery: { state: string; error: string | null };
};

export const workspace: Workspace = { mount(ctx) {
  ctx.root.setAttribute('data-handoff-module', '');
  let disposed = false, available = false, submitBusy = false, optionsGeneration = 0;
  const commandState = createCommandState({ scope: ctx.scope, actor: ctx.actor, signal: ctx.signal, isCurrent: () => !disposed });
  let pendingSubmit: CapturedCommandIntent | undefined;
  const reconciliationCommands = new Map<string, CapturedCommandIntent>();
  const reconciling = new Set<string>();

  ctx.root.append(heading('Cross-product handoffs', 'Choose a permitted document and request a linked action. The destination remains the owner of its record.'));
  const stats = el('div', 'stat-grid'); ctx.root.append(stats);
  const flow = el('div', 'handoff-flow');
  flow.append(el('span', 'flow-node', 'Knowledge'), el('span', 'flow-link', '→'), el('span', 'flow-node', 'Bound public operation'), el('span', 'flow-link', '→'), el('span', 'flow-node', 'Service Desk'));
  ctx.root.append(flow);
  const grid = el('div', 'grid'), create = section(), list = section(); grid.append(create, list); ctx.root.append(grid);
  create.append(el('h3', '', 'Create a linked request'));
  const readiness = el('div', 'handoff-readiness');
  const showReadiness = (kind: Parameters<typeof statusNotice>[0], message: string) => readiness.replaceChildren(statusNotice(kind, message));
  showReadiness('pending', 'Checking permitted documents and connection prerequisites…'); create.append(readiness);
  const form = el('form'), sourceField = fieldControl('Source document', el('select'), { required: true, help: 'Choose a document this session may read.' }), select = sourceField.input, reason = fieldControl('Reason for the service request', el('textarea'), { required: true, maxLength: 64000, help: 'Explain why the selected source needs Service Desk attention.' });
  select.name = 'documentId'; select.disabled = true; reason.input.name = 'reason';
  form.append(sourceField.wrap, reason.wrap);
  const submitButton = actionButton('Request Service Desk action', () => {}); submitButton.type = 'submit';
  form.append(submitButton);
  const submitStatus = el('div', 'handoff-submit-status');
  const showSubmitStatus = (kind: Parameters<typeof statusNotice>[0], message: string) => submitStatus.replaceChildren(statusNotice(kind, message));
  const retrySubmit = actionButton('Retry the exact source submission', () => { if (pendingSubmit) void sendSubmission(pendingSubmit, true); }, { variant: 'secondary', size: 'small' }); retrySubmit.hidden = true;
  const refreshStatus = el('p', 'small muted'); refreshStatus.setAttribute('role', 'status');
  const refreshButton = actionButton('Refresh handoffs', () => void refreshWithStatus(), { variant: 'secondary', size: 'small' });
  if (ctx.permissions.includes('handoff.create')) create.append(form, submitStatus, retrySubmit, refreshStatus);
  else create.append(statusNotice('read-only', 'Read access only.'));
  create.append(refreshButton);

  async function refresh() {
    const data = await ctx.api.get('/api/handoffs', ctx.signal) as { items: HandoffItem[] };
    if (ctx.signal.aborted || disposed) return;
    stats.replaceChildren(
      statistic('Loaded handoffs', data.items.length, 'Current response · current tenant'),
      statistic('Destination confirmed', data.items.filter(x => x.outcome === 'DESTINATION_COMMITTED').length, 'Separate from local job success'),
      statistic('Confirmation needed', data.items.filter(x => x.outcome === 'ACCEPTANCE_UNKNOWN').length, 'Check the original receipt')
    );
    list.replaceChildren(el('h3', '', 'Requests and confirmations'));
    if (!data.items.length) list.append(emptyState('No linked requests yet.', 'Choose a permitted source document to begin.'));
    for (const item of data.items) {
      const node = el('article', 'list-item');
      node.append(el('div', 'item-meta', labels[item.outcome] || item.outcome), el('h3', '', item.title));
      node.append(el('p', 'muted', `Local execution: ${labels[item.delivery.state] || item.delivery.state}. Source workflow: ${item.state === 'ACCEPTED' ? 'Destination linked' : 'Pending owner completion'}.`));
      const details = el('details'), summary = el('summary', '', 'Technical details'); details.append(summary, el('p', 'receipt', item.id));
      if (item.target_ref) details.append(el('p', 'receipt', JSON.stringify(item.target_ref)));
      if (item.delivery.error) details.append(el('p', 'error', `Local attempt: ${item.delivery.error}`));
      node.append(details);
      if (item.outcome === 'DESTINATION_COMMITTED' && item.delivery.state !== 'SUCCEEDED')
        node.append(el('p', 'muted', 'The destination committed. Local completion is separate; do not send a new request.'));
      if (item.outcome === 'ACCEPTANCE_UNKNOWN') {
        node.append(el('p', 'muted', 'The original request may have committed. Ending retries does not establish that nothing happened.'));
        if (ctx.permissions.includes('handoff.reconcile')) {
          const check = actionButton('Check original receipt', () => void reconcile(item.id), { variant: 'secondary', size: 'small' });
          check.disabled = reconciling.has(item.id);
          node.append(check);
        }
      }
      list.append(node);
    }
  }

  async function refreshWithStatus() {
    try {
      await refresh();
      if (!ctx.signal.aborted && !disposed) refreshStatus.textContent = '';
    } catch (error) {
      if (!ctx.signal.aborted && !disposed)
        refreshStatus.textContent = `The handoff list could not be refreshed. Any confirmed submission remains submitted: ${error instanceof Error ? error.message : 'service unavailable'}`;
    }
  }

  async function sendSubmission(intent: CapturedCommandIntent, retry: boolean) {
    if (submitBusy || ctx.signal.aborted || disposed) return;
    submitBusy = true; submitButton.disabled = true; retrySubmit.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    showSubmitStatus('pending', 'Sending the captured source request…');
    try {
      const dispatch = (commandId: string, payload: unknown) => ctx.api.post('/api/handoffs', payload, commandId, ctx.signal);
      await (retry ? commandState.retry(intent, dispatch) : commandState.send(intent, dispatch));
      if (ctx.signal.aborted || disposed) return;
      pendingSubmit = undefined; retrySubmit.hidden = true;
      form.reset(); select.disabled = !available;
      showSubmitStatus('success', 'Source submission confirmed. Destination acceptance and local completion remain separate.');
      await refreshWithStatus();
    } catch (error) {
      if (ctx.signal.aborted || disposed) return;
      pendingSubmit = intent; retrySubmit.hidden = false;
      showSubmitStatus('unknown', `Source submission is unconfirmed. Retry preserves the original command identity and request: ${error instanceof Error ? error.message : 'unknown outcome'}`);
    } finally {
      submitBusy = false;
      submitButton.removeAttribute('aria-busy');
      submitButton.disabled = !available || !!pendingSubmit || ctx.signal.aborted || disposed;
      retrySubmit.disabled = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!available || submitBusy || pendingSubmit || ctx.signal.aborted || disposed) return;
    const payload = { documentId: select.value, reason: reason.input.value };
    submitBusy = true; submitButton.disabled = true; submitButton.setAttribute('aria-busy', 'true'); showSubmitStatus('pending', 'Capturing the source command identity…');
    try {
      const intent = await commandState.capture('handoff:create', 'handoff.create', payload);
      if (ctx.signal.aborted || disposed) return;
      pendingSubmit = intent;
      submitBusy = false;
      await sendSubmission(intent, false);
    } catch (error) {
      if (!ctx.signal.aborted && !disposed) showSubmitStatus('unknown', `The earlier source request remains unresolved; only its exact retry is available: ${error instanceof Error ? error.message : 'unknown outcome'}`);
    } finally {
      submitBusy = false;
      submitButton.removeAttribute('aria-busy');
      submitButton.disabled = !available || !!pendingSubmit || ctx.signal.aborted || disposed;
    }
  }

  async function reconcile(handoffId: string) {
    if (reconciling.has(handoffId) || ctx.signal.aborted || disposed) return;
    reconciling.add(handoffId);
    try {
      let intent = reconciliationCommands.get(handoffId);
      const retry = !!intent && commandState.state(intent) === 'UNKNOWN';
      if (!intent) {
        intent = await commandState.capture(`handoff:reconcile:${handoffId}`, 'handoff.reconcile', { id: handoffId });
        reconciliationCommands.set(handoffId, intent);
      }
      const dispatch = (commandId: string, payload: unknown) => ctx.api.post('/api/handoffs/reconcile', payload, commandId, ctx.signal);
      await (retry ? commandState.retry(intent, dispatch) : commandState.send(intent, dispatch));
      if (ctx.signal.aborted || disposed) return;
      reconciliationCommands.delete(handoffId);
      await refreshWithStatus();
    } catch (error) {
      if (!ctx.signal.aborted && !disposed)
        ctx.notice(`Receipt check is unconfirmed. Retry keeps its original reconciliation identity: ${error instanceof Error ? error.message : 'unknown outcome'}`);
    } finally {
      reconciling.delete(handoffId);
      if (!ctx.signal.aborted && !disposed) await refreshWithStatus();
    }
  }

  const loadOptions = async () => {
    const generation = ++optionsGeneration; available = false; select.disabled = true; submitButton.disabled = true;
    try {
      const result = await ctx.api.get('/api/handoffs/options', ctx.signal) as { documents: { id: string; title: string; version: number }[]; connection: { state: string; message?: string } };
      if (ctx.signal.aborted || disposed || generation !== optionsGeneration) return;
      const old = select.value; select.replaceChildren();
      const placeholder = el('option', '', 'Choose a source document'); placeholder.value = ''; select.append(placeholder);
      for (const doc of result.documents) { const option = el('option', '', `${doc.title} · v${doc.version}`); option.value = doc.id; select.append(option); }
      if (result.documents.some(document => document.id === old)) select.value = old;
      available = result.connection.state === 'READY'; select.disabled = !available;
      submitButton.disabled = !available || !!pendingSubmit;
      showReadiness(available ? (result.documents.length ? 'success' : 'empty') : 'warning', available
        ? (result.documents.length ? 'Connection prerequisites checked. Authorization is checked again when you submit.' : 'No permitted documents in this returned list. Add a document in Knowledge, then refresh.')
        : (result.connection.message || 'Connection is not ready. No new handoff will be submitted.'));
    } catch (error) {
      if (!ctx.signal.aborted && !disposed && generation === optionsGeneration) {
        select.replaceChildren(); showReadiness('danger', error instanceof Error ? error.message : 'Document options could not be loaded.');
      }
    }
  };

  form.addEventListener('submit', event => void submit(event as SubmitEvent), { signal: ctx.signal });
  create.append(actionButton('Refresh documents & connection', () => void loadOptions(), { variant: 'secondary', size: 'small' }));
  void loadOptions(); void refreshWithStatus();
  const timer = setInterval(() => void refreshWithStatus(), 2000);
  return () => { disposed = true; commandState.dispose(); optionsGeneration++; clearInterval(timer); reconciliationCommands.clear(); };
} };
