export class FixtureNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.id = '';
    this.name = '';
    this.type = '';
    this.value = '';
    this.required = false;
    this.maxLength = -1;
    this.rows = 0;
    this.disabled = false;
    this.hidden = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.dataset = {};
    this._textContent = '';
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this._textContent = ''; this.children.push(...nodes); }
  replaceChildren(...nodes) { this._textContent = ''; this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  async dispatch(type, event = {}) {
    const dispatched = { preventDefault() {}, target: this, ...event };
    for (const listener of this.listeners.get(type) ?? []) await listener(dispatched);
  }
}

export function installUiDomFixture() {
  const previousDocument = globalThis.document;
  const previousInput = globalThis.HTMLInputElement;
  const previousTextarea = globalThis.HTMLTextAreaElement;
  const previousSelect = globalThis.HTMLSelectElement;
  globalThis.document = { createElement: tagName => new FixtureNode(tagName) };
  // Intentionally leave the browser constructors absent to cover cross-realm and light-DOM consumers.
  delete globalThis.HTMLInputElement;
  delete globalThis.HTMLTextAreaElement;
  delete globalThis.HTMLSelectElement;
  return () => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousInput === undefined) delete globalThis.HTMLInputElement;
    else globalThis.HTMLInputElement = previousInput;
    if (previousTextarea === undefined) delete globalThis.HTMLTextAreaElement;
    else globalThis.HTMLTextAreaElement = previousTextarea;
    if (previousSelect === undefined) delete globalThis.HTMLSelectElement;
    else globalThis.HTMLSelectElement = previousSelect;
  };
}
