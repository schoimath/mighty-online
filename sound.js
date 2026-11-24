const AudioEngine = window.AudioContext || window.webkitAudioContext;
const storageKey = "mighty-sound";
let enabled = true;
try { enabled = localStorage.getItem(storageKey) !== "off"; } catch {}

let context;
let output;
let resuming;
let lastLanding = -Infinity;
const buffers = new Map();

const cues = {
  deal: {duration: .20, strokes: [0, .045, .093], decay: .019, tone: 125, tap: .10},
  play: {duration: .105, strokes: [0], decay: .014, tone: 150, tap: .46},
  ruff: {duration: .24, strokes: [0, .032, .046], decay: .021, tone: 190, tap: .24},
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

function makeSound(kind) {
  if (kind === "bid") {
    // A struck bell at C4. The contract sets the pitch at playback.
    const rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.ceil(rate * .40), rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate;
      const phase = 2 * Math.PI * 261.63 * t;
      const envelope = Math.min(1, t / .006, (.40 - t) / .035);
      samples[i] = envelope * (.62 * Math.sin(phase) * Math.exp(-t / .115)
        + .23 * Math.sin(2 * phase) * Math.exp(-t / .073)
        + .10 * Math.sin(3 * phase) * Math.exp(-t / .042));
    }
    return buffer;
  }
  const buffer = paperSound(cues[kind]);
  if (kind !== "ruff") return buffer;
  // A short paper flick lands on a lower, resonant table knock.
  const samples = buffer.getChannelData(0);
  const impact = Math.round(.032 * buffer.sampleRate);
  for (let i = impact; i < samples.length; i++) {
    const t = (i - impact) / buffer.sampleRate;
    const phase = 2 * Math.PI * (119 * t + 3.6 * (1 - Math.exp(-t / .021)));
    const envelope = Math.min(1, t / .002) * Math.exp(-t / .040);
    samples[i] += envelope * (.75 * Math.sin(phase) + .19 * Math.sin(2.43 * phase));
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

export function playTableSound(kind, bid) {
  if (!enabled || document.hidden || !context || !output) return;
  if (context.state !== "running") {
    // Starting practice can mount the table in the same click that unlocks audio.
    const requestedAt = performance.now();
    resuming?.then(() => {
      if (context.state === "running" && performance.now() - requestedAt < 180) playTableSound(kind, bid);
    });
    return;
  }
  if (kind === "play") {
    const now = performance.now();
    if (now - lastLanding < 45) return;
    lastLanding = now;
  }
  if (!buffers.has(kind)) buffers.set(kind, makeSound(kind));
  const source = context.createBufferSource();
  source.buffer = buffers.get(kind);
  if (kind === "bid") {
    const semitones = 2 * (bid.points - 13) + Number(bid.suit === "N");
    source.playbackRate.value = 2 ** (semitones / 12);
  }
  source.connect(output);
  source.onended = () => source.disconnect();
  source.start();
}
