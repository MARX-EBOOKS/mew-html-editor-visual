// Native VS Code document access for the shared PDF review scripts.
(() => {
  "use strict";
  class VSCodeController {
    constructor(send, request) {
      this.send = send;
      this.request = request;
      this.listeners = new Map();
      this.collections = new Set();
      this.actions = new Map();
      this.editor = this;
      for (const name of ["onDidChangeModel", "onDidChangeModelContent", "onDidChangeCursorSelection", "onDidDispose"]) {
        this[name] = callback => {
          const listeners = this.listeners.get(name) || new Set();
          this.listeners.set(name, listeners); listeners.add(callback);
          return { dispose: () => listeners.delete(callback) };
        };
      }
    }
    emit(name, event) { this.listeners.get(name)?.forEach(callback => callback(event)); }
    receive(snapshot) {
      const previous = this.snapshot;
      this.snapshot = snapshot;
      if (previous?.uri !== snapshot.uri || previous?.version !== snapshot.version)
        this.collections.forEach(collection => collection.clear());
      if (previous?.uri !== snapshot.uri) {
        this.model = snapshot.uri ? {
          uri: { toString: () => snapshot.uri },
          getValue: () => this.snapshot.text,
          getVersionId: () => this.snapshot.version,
          getLanguageId: () => "html",
          getPositionAt: offset => this.positionAt(offset),
          getOffsetAt: position => this.offsetAt(position),
          getValueInRange: range => this.snapshot.text.slice(this.offsetAt(this.range(range).getStartPosition()), this.offsetAt(this.range(range).getEndPosition())),
          validateRange: range => this.range(range)
        } : null;
        this.emit("onDidChangeModel", {});
      } else if (previous?.text !== snapshot.text) this.emit("onDidChangeModelContent", {
        changes: snapshot.version === previous?.version + 1 && snapshot.changes?.length ? snapshot.changes
          : [{ rangeOffset: 0, rangeLength: previous?.text.length || 0, text: snapshot.text }]
      });
      else if (JSON.stringify(previous?.selections) !== JSON.stringify(snapshot.selections))
        this.emit("onDidChangeCursorSelection", { source: "keyboard" });
    }
    positionAt(offset) {
      const text = this.getValue(); offset = Math.max(0, Math.min(text.length, offset));
      const lines = text.slice(0, offset).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
    }
    offsetAt({ lineNumber, column }) {
      const lines = this.getValue().split("\n");
      return lines.slice(0, lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + column - 1;
    }
    range(value) {
      const range = { ...value };
      range.getStartPosition = () => ({ lineNumber: range.startLineNumber, column: range.startColumn });
      range.getEndPosition = range.getPosition = () => ({ lineNumber: range.endLineNumber, column: range.endColumn });
      range.equalsRange = other => !!other && ["startLineNumber", "startColumn", "endLineNumber", "endColumn"].every(key => range[key] === other[key]);
      range.isEmpty = () => range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
      range.containsPosition = position => this.offsetAt(position) >= this.offsetAt(range.getStartPosition()) && this.offsetAt(position) <= this.offsetAt(range.getEndPosition());
      range.toString = () => `${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}`;
      // Only coordinates cross the webview bridge; range methods stay local.
      for (const key of Object.keys(range))
        if (typeof range[key] === "function") Object.defineProperty(range, key, { enumerable: false });
      return range;
    }
    get nativeEditor() { return true; }
    getId() { return "mewReader"; }
    getAction(id) { return this.actions.get(id); }
    addAction(action) {
      this.actions.set(action.id, action);
      return { dispose: () => this.actions.delete(action.id) };
    }
    getModel() { return this.model; }
    get layout() { return this.snapshot?.layout || null; }
    get splitView() { return this.layout?.splitView ?? null; }
    getValue() { return this.snapshot?.text || ""; }
    getOption() { return !!this.snapshot?.readOnly; }
    getDomNode() { return document.body; }
    hasTextFocus() { return false; }
    getTargetAtClientPoint() { return null; }
    getSelections() { return (this.snapshot?.selections || []).map(value => this.range(value)); }
    getSelection() { return this.getSelections()[0] || this.range({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }); }
    setSelection(range) { this.send("reviewSelection", { selections: [range] }); }
    setPosition(position) { this.setSelection({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }); }
    revealRangeInCenterIfOutsideViewport() {} // reviewSelection reveals in the native editor.
    focus() { this.send("reviewFocus", {}); }
    createDecorationsCollection() {
      let values = [];
      const update = () => this.send("reviewDecorations", { decorations: [...this.collections].flatMap(collection => collection.values()).map(value => ({ range: value.range, className: value.options.inlineClassName ?? value.options.before?.inlineClassName ?? value.options.after?.inlineClassName, hoverMessage: value.options.hoverMessage, after: value.options.after })) });
      const collection = {
        values: () => values,
        get length() { return values.length; },
        getRange: index => values[index] && this.range(values[index].range),
        set: decorations => { this.collections.add(collection); values = decorations; update(); },
        clear: () => { this.collections.delete(collection); values = []; update(); }
      };
      this.collections.add(collection);
      return collection;
    }
    executeEdits(origin, edits) {
      return this.applyReviewEdits(edits.map(edit => ({
        start: this.offsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn }),
        end: this.offsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn }), text: edit.text
      })), this.getValue());
    }
    applyReviewEdits(edits, source) { return this.request("reviewApply", { edits, source }); }
    previewReview({ before, after, edits = [] }) {
      for (const edit of [...edits].reverse()) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
      return this.request("reviewPreview", { before, after });
    }
    save() { return this.request("reviewSave", { source: this.getValue() }); }
    showReviewHover(range, hover, focus = false) { this.send("reviewHover", { range, hover, focus }); }
    async runReviewAction(action) {
      if (!['prev', 'next', 'apply', 'advance', 'all', 'save', 'preview-diff', 'close'].includes(action)) return;
      const button = document.querySelector(`.replacement-review:not([hidden]) [data-${action}]`);
      if (button && !button.disabled && !button.hidden) {
        try { await button.onclick?.call(button); }
        finally { window.ReplacementReview?.refreshPresentation(); }
      }
    }
    bindReviewSuggestions(provide, getSession) {
      this.suggestionProvider = provide || this.suggestionProvider;
      this.reviewSession = getSession || this.reviewSession;
      const active = this.reviewSession?.();
      const plans = this.suggestionProvider?.(this.getModel()) || (active ? active.items.flatMap(item => item.options) : []);
      if (this.plans === plans && this.plansVersion === this.snapshot?.version) return;
      this.plans = plans; this.plansVersion = this.snapshot?.version;
      this.send("reviewPlans", { plans });
    }
    dispose() { this.emit("onDidDispose"); this.listeners.clear(); this.collections.clear(); this.actions.clear(); }
  }
  window.MewEditorCore = { VSCodeController };
})();
