export type UiSurface = 'light' | 'dark';
export type UiTextContrast = 'standard' | 'high-contrast';
export type UiAccent = 'blue' | 'teal' | 'amber';
export type UiDensity = 'comfortable' | 'compact';
export type UiLayoutMode = 'reading' | 'operational';

export interface UiBoundaryTheme {
  surface?: UiSurface;
  text?: UiTextContrast;
  accent?: UiAccent;
  density?: UiDensity;
}

/** Apply a complete, safe theme boundary. Defaults make nested boundaries reset every palette axis. */
export function applyUiBoundary(element: HTMLElement, theme: UiBoundaryTheme = {}): void {
  element.setAttribute('data-qb-ui-boundary', '');
  element.setAttribute('data-qb-surface', theme.surface ?? 'light');
  element.setAttribute('data-qb-text', theme.text ?? 'standard');
  element.setAttribute('data-qb-accent', theme.accent ?? 'teal');
  element.setAttribute('data-qb-density', theme.density ?? 'comfortable');
}

export function applyUiLayout(element: HTMLElement, mode: UiLayoutMode): void {
  element.setAttribute('data-qb-layout-mode', mode);
}

/** Safe DOM constructor retained as the small native-ESM escape hatch. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
}

export function button(label: string, handler: () => void, cls = 'button secondary'): HTMLButtonElement {
  const node = el('button', cls, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

export interface ActionButtonOptions {
  disabled?: boolean;
  pending?: boolean;
  pendingText?: string;
  disabledReason?: string;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'regular' | 'small';
}

/** A button with explicit disabled and pending presentation supplied by its owner. */
export function actionButton(label: string, handler: () => void, options: ActionButtonOptions = {}): HTMLButtonElement {
  const variant = options.variant ?? 'primary';
  const node = button(label, handler, `button qb-action-button ${options.size === 'small' ? 'small' : ''} ${variant === 'primary' ? '' : `qb-action-button-${variant}`}`.trim());
  node.disabled = options.disabled === true || options.pending === true;
  if (options.pending) {
    node.setAttribute('aria-busy', 'true');
    const pending = el('span', 'qb-action-pending', ` · ${options.pendingText ?? 'Working…'}`);
    node.append(pending);
  }
  if (options.disabledReason) {
    node.append(el('span', 'qb-action-reason', ` · ${options.disabledReason}`));
  }
  return node;
}

export interface FieldOptions {
  help?: string;
  error?: string;
  required?: boolean;
  maxLength?: number;
  type?: 'text' | 'search' | 'email' | 'password' | 'number' | 'url';
  placeholder?: string;
  autocomplete?: string;
  rows?: number;
}

export interface FieldControl<T extends HTMLElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> {
  wrap: HTMLLabelElement;
  input: T;
  setError(message?: string): void;
}

let nextControlId = 1;
function controlId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return `qb-control-${cryptoApi.randomUUID()}`;
  return `qb-control-${Date.now().toString(36)}-${(nextControlId++).toString(36)}`;
}

function describedBy(control: HTMLElement, ids: readonly string[]): void {
  const value = ids.filter(Boolean).join(' ');
  if (value) control.setAttribute('aria-describedby', value);
  else control.removeAttribute('aria-describedby');
}

/** Associate a native control with a unique label and optional help/error text. */
export function fieldControl<T extends HTMLElement>(label: string, input: T, options: FieldOptions = {}): FieldControl<T> {
  const wrap = el('label', 'field qb-field');
  const labelNode = el('span', 'field-label', label);
  const id = controlId();
  input.id = id;
  if ('required' in input && typeof options.required === 'boolean') (input as unknown as HTMLInputElement).required = options.required;
  if ('maxLength' in input && options.maxLength !== undefined) (input as unknown as HTMLInputElement | HTMLTextAreaElement).maxLength = options.maxLength;
  const controlTag = (input.tagName ?? input.localName ?? '').toLowerCase();
  if (controlTag === 'input') {
    const textInput = input as unknown as HTMLInputElement;
    if (options.type) textInput.type = options.type;
    if (options.placeholder !== undefined) textInput.placeholder = options.placeholder;
    if (options.autocomplete !== undefined) textInput.setAttribute('autocomplete', options.autocomplete);
  }
  if (controlTag === 'textarea') {
    const textArea = input as unknown as HTMLTextAreaElement;
    if (options.placeholder !== undefined) textArea.placeholder = options.placeholder;
    if (options.rows !== undefined) textArea.rows = options.rows;
  }
  const help = options.help ? el('span', 'qb-field-help', options.help) : undefined;
  if (help) help.id = `${id}-help`;
  const error = el('span', 'qb-field-error');
  error.id = `${id}-error`;
  error.hidden = true;
  wrap.append(labelNode, input);
  if (help) wrap.append(help);
  wrap.append(error);
  const setError = (message?: string) => {
    const present = typeof message === 'string' && message.length > 0;
    error.textContent = present ? message : '';
    error.hidden = !present;
    if (present) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    describedBy(input, [help?.id ?? '', present ? error.id : '']);
  };
  describedBy(input, [help?.id ?? '']);
  if (options.error) setError(options.error);
  return { wrap, input, setError };
}

/** Compatibility field with the original required/maxLength defaults and return shape. */
export function field(label: string, name: string, multiline = false): { wrap: HTMLLabelElement; input: HTMLInputElement | HTMLTextAreaElement } {
  const input = multiline ? el('textarea') : el('input');
  input.name = name;
  input.required = true;
  input.maxLength = multiline ? 64000 : 200;
  const result = fieldControl(label, input);
  result.wrap.className = 'field';
  return { wrap: result.wrap, input: result.input };
}

export type StatusKind = 'pending' | 'success' | 'warning' | 'danger' | 'info' | 'unknown' | 'conflict' | 'empty' | 'read-only';

const statusLabels: Record<StatusKind, string> = {
  pending: 'Pending', success: 'Complete', warning: 'Needs attention', danger: 'Error', info: 'Information',
  unknown: 'Outcome unknown', conflict: 'Conflict', empty: 'No results', 'read-only': 'Read only'
};

/** Present the exact state supplied by the caller; this helper never infers command outcomes. */
export function statusNotice(kind: StatusKind, message: string, label = statusLabels[kind]): HTMLDivElement {
  const notice = el('div', 'qb-status-notice');
  notice.setAttribute('data-qb-status', kind);
  notice.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
  notice.setAttribute('aria-live', kind === 'danger' ? 'assertive' : 'polite');
  notice.append(el('span', 'qb-status-label', label), el('span', 'qb-status-message', message));
  return notice;
}

export function heading(title: string, subtitle: string): HTMLDivElement {
  const result = el('div', 'section-heading');
  result.append(el('h2', '', title), el('p', 'muted', subtitle));
  return result;
}

export function formAction(form: HTMLFormElement, label: string, handler: () => Promise<void>, signal: AbortSignal, notice: (message: string) => void): void {
  const submit = el('button', 'button', label);
  submit.type = 'submit';
  const pending = el('span', 'qb-form-pending', 'Submitting…');
  pending.hidden = true;
  pending.setAttribute('role', 'status');
  pending.setAttribute('aria-live', 'polite');
  form.append(submit, pending);
  let busy = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || signal.aborted) return;
    busy = true;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    pending.hidden = false;
    try {
      await handler();
    } catch (error) {
      if (!signal.aborted) notice(error instanceof Error ? error.message : 'Operation failed');
    } finally {
      busy = false;
      submit.removeAttribute('aria-busy');
      if (!signal.aborted) {
        submit.disabled = false;
        pending.hidden = true;
      } else {
        pending.textContent = 'This view stopped waiting.';
      }
    }
  }, { signal });
}

export function section(cls = 'card'): HTMLElement {
  return el('section', cls);
}

export function statistic(label: string, value: string | number, note = ''): HTMLDivElement {
  const card = el('div', 'stat-card');
  card.append(el('span', 'stat-label', label), el('strong', 'stat-value', String(value)));
  if (note) card.append(el('span', 'small muted', note));
  return card;
}

export function emptyState(title: string, detail: string): HTMLDivElement {
  const block = el('div', 'list-empty');
  block.append(el('div', 'empty-symbol', '◇'), el('h3', '', title), el('p', 'muted small', detail));
  return block;
}
