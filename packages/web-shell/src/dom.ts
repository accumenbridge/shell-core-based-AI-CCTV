/** Small DOM helpers for reference modules. This is not a replacement virtual-DOM framework. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', value?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = cls;
    if (value !== undefined)
        node.textContent = value;
    return node;
}
export function button(label: string, handler: () => void, cls = 'button secondary') { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', handler); return b; }
export function field(label: string, name: string, multiline = false) { const wrap = el('label', 'field'); wrap.append(el('span', 'field-label', label)); const input = multiline ? el('textarea') : el('input'); input.name = name; input.required = true; input.maxLength = multiline ? 64000 : 200; wrap.append(input); return { wrap, input }; }
export function heading(title: string, subtitle: string) { const h = el('div', 'section-heading'); h.append(el('h2', '', title), el('p', 'muted', subtitle)); return h; }
export function formAction(form: HTMLFormElement, label: string, handler: () => Promise<void>, signal: AbortSignal, notice: (s: string) => void) {
    const submit = el('button', 'button', label);
    submit.type = 'submit';
    form.append(submit);
    let busy = false;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy || signal.aborted)
            return;
        busy = true;
        submit.disabled = true;
        try {
            await handler();
        }
        catch (error) {
            if (!signal.aborted)
                notice(error instanceof Error ? error.message : 'Operation failed');
        }
        finally {
            busy = false;
            if (!signal.aborted)
                submit.disabled = false;
        }
    }, { signal });
}
export function section(cls = 'card') { return el('section', cls); }

/** Presentation-only statistic. The caller owns the meaning and scope of the number. */
export function statistic(label: string, value: string | number, note = '') {
    const card = el('div', 'stat-card');
    card.append(el('span', 'stat-label', label), el('strong', 'stat-value', String(value)));
    if (note) card.append(el('span', 'small muted', note));
    return card;
}
export function emptyState(title: string, detail: string) {
    const block = el('div', 'list-empty');
    block.append(el('div', 'empty-symbol', '◇'), el('h3', '', title), el('p', 'muted small', detail));
    return block;
}
