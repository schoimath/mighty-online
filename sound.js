const AudioEngine = window.AudioContext || window.webkitAudioContext;
const storageKey = "mighty-sound";
let enabled = true;
try { enabled = localStorage.getItem(storageKey) !== "off"; } catch {}

let context;
let output;
let resuming;
let lastLanding = -Infinity;
const buffers = new Map();

// The three envelopes shape the same paper texture into a riffle, tap and sweep.
const cues = {
  deal: {duration: .20, strokes: [0, .045, .093], decay: .019, tone: 125, tap: .10},
  play: {duration: .105, strokes: [0], decay: .014, tone: 150, tap: .46},
  collect: {duration: .23, strokes: [0, .065], decay: .038, tone: 105, tap: .12}
};

function paperSound(cue) {
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.ceil(rate * cue.duration), rate);
  const samples = buffer.getChannelData(0);
  const fastMix = 1 - Math.exp(-2 * Math.PI * 3600 / rate);
  const slowMix = 1 - Math.exp(-2 * Math.PI * 750 / rate);
  let fast = 0, slow = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const noise = Math.random() * 2 - 1;
    fast += fastMix * (noise - fast);
    slow += slowMix * (noise - slow);
    let envelope = 0;
    for (const start of cue.strokes) {
      const age = t - start;
      if (age >= 0) envelope += Math.min(1, age / .004) * Math.exp(-age / cue.decay);
    }
    const tap = cue.tap * Math.sin(2 * Math.PI * cue.tone * t) * Math.exp(-t / .035);
    const endFade = Math.min(1, (samples.length - 1 - i) / (rate * .008));
    samples[i] = envelope * (fast - slow + tap) * endFade;
  }
  return buffer;
}

function setVolume() {
  if (output) output.gain.value = enabled && !document.hidden ? .19 : 0;
}

function unlock() {
  if (!AudioEngine || !enabled || document.hidden) return;
  try {
    if (!context) {
      context = new AudioEngine();
      output = context.createGain();
      output.connect(context.destination);
      setVolume();
    }
    if (context.state !== "running" && !resuming) {
      resuming = context.resume().catch(() => {}).finally(() => { resuming = null; });
    }
  } catch { /* A device without audio can still play the game. */ }
}

// Join and practice both start with a user gesture, before the table is mounted.
for (const type of ["pointerup", "click", "keydown"]) {
  document.addEventListener(type, event => { if (event.isTrusted) unlock(); }, {capture: true, passive: true});
}
document.addEventListener("visibilitychange", setVolume);

export function soundControl(button) {
  button.disabled = !AudioEngine;
  button.setAttribute("aria-pressed", String(Boolean(AudioEngine) && enabled));
  button.title = !AudioEngine ? "이 브라우저에서는 효과음을 지원하지 않습니다." : enabled ? "효과음 끄기" : "효과음 켜기";
}

export function toggleSound(button) {
  enabled = !enabled;
  try { localStorage.setItem(storageKey, enabled ? "on" : "off"); } catch {}
  if (enabled) unlock();
  setVolume();
  soundControl(button);
}

export function playTableSound(kind) {
  if (!enabled || document.hidden || !context || !output) return;
  if (context.state !== "running") {
    // Starting practice can mount the table in the same click that unlocks audio.
    const requestedAt = performance.now();
    resuming?.then(() => {
      if (context.state === "running" && performance.now() - requestedAt < 180) playTableSound(kind);
    });
    return;
  }
  if (kind === "play") {
    const now = performance.now();
    if (now - lastLanding < 45) return;
    lastLanding = now;
  }
  if (!buffers.has(kind)) buffers.set(kind, paperSound(cues[kind]));
  const source = context.createBufferSource();
  source.buffer = buffers.get(kind);
  source.connect(output);
  source.onended = () => source.disconnect();
  source.start();
}
