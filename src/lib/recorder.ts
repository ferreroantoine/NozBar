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

/** Convertit l'enregistrement (webm/opus) en WAV 16 kHz mono, format accepté par Gemini. */
export async function toWavBase64(blob: Blob): Promise<{ data: string; seconds: number }> {
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
  return { data: bytesToBase64(encodeWav(pcm, TARGET_RATE)), seconds: decoded.duration };
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
