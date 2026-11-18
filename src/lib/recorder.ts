// Capture micro pour le push-to-talk, avec niveau sonore pour l'orbe.

const TARGET_RATE = 16_000;

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audio: AudioContext | null = null;
  private chunks: Blob[] = [];
  private frame = 0;
  private starting: Promise<void> | null = null;
  private cancelled = false;

  /** `onLevel` reçoit l'amplitude du micro entre 0 et 1, à chaque image. */
  start(onLevel: (level: number) => void): Promise<void> {
    this.starting = this.open(onLevel);
    return this.starting;
  }

  private async open(onLevel: (level: number) => void) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (this.cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    this.audio = new AudioContext();
    const analyser = this.audio.createAnalyser();
    analyser.fftSize = 512;
    this.audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 8));
      this.frame = requestAnimationFrame(tick);
    };
    tick();

    this.recorder = new MediaRecorder(stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** Arrête l'enregistrement ; `null` si rien n'a été capturé. */
  async stop(): Promise<Blob | null> {
    // La touche peut être relâchée avant que le micro ne soit prêt.
    await this.starting?.catch(() => {});
    const rec = this.recorder;
    if (!rec || rec.state === "inactive") {
      this.release();
      return null;
    }
    const stopped = new Promise<void>((r) => rec.addEventListener("stop", () => r(), { once: true }));
    rec.stop();
    await stopped;
    this.release();
    return this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType }) : null;
  }

  cancel() {
    this.cancelled = true;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.release();
  }

  private release() {
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audio?.close();
    this.stream = null;
    this.audio = null;
  }
}

const FRAME_SECONDS = 0.02;
/** En dessous, c'est du silence quel que soit le bruit de fond (≈ -40 dBFS). */
const MIN_SPEECH_RMS = 0.01;
/** Une trame parlée dépasse nettement le bruit de fond de l'enregistrement. */
const NOISE_FLOOR_RATIO = 4;
/** Plafond du seuil : si l'on parle sans pause, le « bruit de fond » mesuré est la voix elle-même. */
const MAX_SPEECH_RMS = 0.03;

/**
 * Durée parlée de l'enregistrement, en secondes : les trames nettement plus fortes que le bruit de fond.
 * Sans parole, on n'envoie rien à l'IA : sur un silence, elle invente une commande (« lance OBS »).
 */
export function speechSeconds(pcm: Float32Array, rate: number): number {
  const size = Math.max(1, Math.round(rate * FRAME_SECONDS));
  const levels: number[] = [];
  for (let start = 0; start + size <= pcm.length; start += size) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += pcm[i] * pcm[i];
    levels.push(Math.sqrt(sum / size));
  }
  if (!levels.length) return 0;
  const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.2)];
  const threshold = Math.min(MAX_SPEECH_RMS, Math.max(MIN_SPEECH_RMS, floor * NOISE_FLOOR_RATIO));
  return levels.filter((l) => l > threshold).length * FRAME_SECONDS;
}

/** Convertit l'enregistrement (webm/opus) en WAV 16 kHz mono, format accepté par Gemini. */
export async function toWavBase64(blob: Blob): Promise<{ data: string; seconds: number; speech: number }> {
  const decoder = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void decoder.close();
  }
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * TARGET_RATE)), TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  return {
    data: bytesToBase64(encodeWav(pcm, TARGET_RATE)),
    seconds: decoded.duration,
    speech: speechSeconds(pcm, TARGET_RATE),
  };
}

function encodeWav(pcm: Float32Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // octets par seconde
  view.setUint16(32, 2, true); // octets par échantillon
  view.setUint16(34, 16, true); // bits par échantillon
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
