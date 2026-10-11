// Runs the engine off the page's main thread. Loaded by importScripts from a
// blob: worker, which inherits the page's CSP (connect-src 'none').
//
// Messages in:  {id, causes: ArrayBuffer[], changes: ArrayBuffer, request: object}
// Messages out: {type: 'ready', sha256} once, then {id, result: string} per run
//               or {id, error: string}.
'use strict';

(async () => {
  try {
    const bin = atob(self.CJCM_WASM);
    const wasm = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) wasm[i] = bin.charCodeAt(i);
    self.CJCM_WASM = null;

    // The hash of the bytes actually about to run, not a value baked into the page.
    let sha256 = '';
    if (self.crypto && crypto.subtle) {
      const d = await crypto.subtle.digest('SHA-256', wasm);
      sha256 = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const go = new self.Go();
    const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
    go.run(instance); // registers self.cjcmRun and blocks on a channel; returns immediately
    if (typeof self.cjcmRun !== 'function') throw new Error('engine did not register cjcmRun');

    self.onmessage = (e) => {
      const { id, causes, changes, request } = e.data;
      try {
        const out = self.cjcmRun(causes.map(b => new Uint8Array(b)), new Uint8Array(changes), JSON.stringify(request));
        self.postMessage({ id, result: out });
      } catch (err) {
        self.postMessage({ id, error: String(err && err.message || err) });
      }
    };
    self.postMessage({ type: 'ready', sha256 });
  } catch (err) {
    self.postMessage({ type: 'failed', error: String(err && err.message || err) });
  }
})();
