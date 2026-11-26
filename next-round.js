const COUNTDOWN_MS = 10000;

// A room host owns this clock. Other seats can display its public state.
export function createNextRoundTimer({onStart, onChange, onError}) {
  let resultKey = null, state = null, timer;

  function change(next) {
    clearTimeout(timer);
    state = next;
    if (next?.status === 'running') {
      timer = setTimeout(() => {
        if (state === next) void startNow();
      }, Math.max(0, next.deadline - Date.now()));
    }
    onChange?.(next);
  }

  function runFor(remainingMs) {
    change({key:resultKey, status:'running', deadline:Date.now() + remainingMs, remainingMs});
  }

  async function startNow() {
    if (!state || state.status === 'starting') return false;
    const starting = {key:resultKey, status:'starting', deadline:null, remainingMs:0};
    change(starting);
    if (state !== starting) return false;
    let success = false;
    try { success = await onStart(starting.key) !== false; }
    catch (error) { onError?.(error); }
    // A late start response cannot alter a different result or a closed table.
    if (state === starting) change(success ? null : {...starting, status:'manual'});
    return success;
  }

  return {
    get state() { return state; },
    sync(key) {
      if (key == null) {
        if (state) change(null);
      } else if (resultKey !== key) {
        resultKey = key;
        runFor(COUNTDOWN_MS);
      }
    },
    pause() {
      if (state?.status === 'running') change({key:resultKey, status:'paused', deadline:null,
        remainingMs:Math.max(0, state.deadline - Date.now())});
    },
    resume() {
      if (state?.status === 'paused') runFor(state.remainingMs);
    },
    startNow
  };
}
