// A rejected promise inside a click handler is invisible: nothing catches it,
// the button stays on "Working…", and the sheet waits for an answer that has
// already failed. Everything that awaits an api.* call from a handler goes
// through here so a failure is said out loud and the control comes back.
//
// `guarded(fn, onError)` returns a handler that runs `fn` and routes both a
// throw and a rejection to `onError(err)`. `settle` runs after either outcome,
// for the part that must happen regardless (re-enable the button, drop the
// listener) — what a `finally` is for, without a block at every call site.
export function guarded(fn, onError, settle) {
  return function guardedHandler(...args) {
    const fail = (err) => { try { onError(err); } catch (_) { /* a failing reporter must not become the next unhandled rejection */ } };
    const done = () => { if (settle) { try { settle(); } catch (_) {} } };
    let out;
    try { out = fn.apply(this, args); } catch (err) { fail(err); done(); return undefined; }
    if (out && typeof out.then === 'function') return out.then((v) => { done(); return v; }, (err) => { fail(err); done(); });
    done();
    return out;
  };
}

export const messageOf = (err, fallback = 'Something went wrong.') =>
  (err && err.message ? String(err.message).split('\n')[0] : '') || fallback;
