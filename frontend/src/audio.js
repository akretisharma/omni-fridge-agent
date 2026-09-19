// Always-on microphone -> utterance segmenter.
//
// Captures raw PCM through an AudioWorklet, detects speech with a simple
// adaptive-energy VAD, and emits one 16 kHz mono WAV blob per utterance (the
// format OMNI accepts as input_audio). Also supports push-to-talk, which
// records regardless of the VAD and can barge in over the assistant's voice.

const TARGET_RATE = 16000;
const SILENCE_END_MS = 900; // this much quiet ends an utterance
const MIN_SPEECH_MS = 350; // ignore clicks/bumps shorter than this
const MAX_UTTERANCE_MS = 20000;
const PREROLL_CHUNKS = 8; // keep ~350ms before the trigger so first words aren't clipped
const MIN_THRESHOLD = 0.02;

function encodeWav(chunks, inRate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(len);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  // Downsample with a box average (cheap anti-aliasing) to 16 kHz.
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.floor(len / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), len);
    let sum = 0;
    for (let j = start; j < end; j++) sum += merged[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }

  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const str = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * @param {MediaStream} stream  stream with an audio track
 * @param {object} opts
 *   canTrigger()   -> bool: may the VAD start an utterance right now? (false while
 *                     the assistant is talking, or hands-free is off)
 *   onSpeechStart()          an utterance began
 *   onSegment(blob)          an utterance ended (16 kHz WAV)
 *   onDiscard()              the utterance was too short to send
 *   onLevel(rms)             ~10x/sec, for a level meter
 */
export async function createMicSegmenter(stream, { canTrigger, onSpeechStart, onSegment, onDiscard, onLevel }) {
  const ctx = new AudioContext();
  await ctx.resume(); // browsers may start it suspended under autoplay rules
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  console.log('mic AudioContext', ctx.state, ctx.sampleRate, 'Hz');
  const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  const mute = ctx.createGain(); // worklets only run when connected; keep it silent
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);

  const chunkMs = (2048 / ctx.sampleRate) * 1000;
  let noise = 0.005;
  let preroll = [];
  let chunks = [];
  let speaking = false;
  let forced = false; // push-to-talk held
  let speechMs = 0;
  let silentMs = 0;
  let totalMs = 0;
  let tick = 0;

  let pttUsed = false; // this utterance was push-to-talk: always send it

  function finish() {
    const send = chunks.length > 0 && (pttUsed || speechMs >= MIN_SPEECH_MS);
    const blob = send ? encodeWav(chunks, ctx.sampleRate) : null;
    speaking = false;
    chunks = [];
    preroll = [];
    speechMs = silentMs = totalMs = 0;
    pttUsed = false;
    if (blob) onSegment(blob);
    else onDiscard?.();
  }

  node.port.onmessage = (e) => {
    const chunk = e.data;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    if (++tick % 3 === 0) onLevel?.(rms);

    const loud = rms > Math.max(MIN_THRESHOLD, noise * 4);
    if (!speaking && !loud) noise = noise * 0.95 + rms * 0.05;

    if (!speaking) {
      if (forced || (loud && canTrigger())) {
        speaking = true;
        chunks = [...preroll, chunk];
        totalMs = chunks.length * chunkMs;
        speechMs = 0;
        silentMs = 0;
        onSpeechStart();
      } else {
        preroll.push(chunk);
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
      }
      return;
    }

    chunks.push(chunk);
    totalMs += chunkMs;
    if (loud || forced) {
      speechMs += chunkMs;
      silentMs = 0;
    } else {
      silentMs += chunkMs;
    }
    if (!forced && (silentMs >= SILENCE_END_MS || totalMs >= MAX_UTTERANCE_MS)) finish();
  };

  return {
    /** Hold-to-talk: true starts recording immediately, false ends and sends. */
    setPushToTalk(on) {
      if (on === forced) return;
      forced = on;
      if (on) pttUsed = true;
      else if (speaking) finish();
      else pttUsed = false;
    },
    stop() {
      node.port.onmessage = null;
      ctx.close();
    },
  };
}
