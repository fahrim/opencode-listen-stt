/**
 * Microphone capture via ffmpeg's DirectShow device, and device enumeration.
 *
 * ffmpeg is used rather than sox: it is already a hard dependency for the
 * plugin, it ships Windows builds with DirectShow, and it avoids pulling a
 * second audio stack in.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";

export interface AudioDevice {
  readonly name: string;
  readonly label: string;
}

/**
 * Strips a DirectShow device line down to the bare device name.
 *
 * ffmpeg lists devices as `"Mikrofon (Realtek(R) Audio)" (audio)` — the name
 * comes first, in quotes, and the kind follows in parentheses. The older
 * `audio="..."` form is also accepted because both appear in the wild.
 */
export function parseDeviceName(raw: string): string {
  // ffmpeg prefixes each line with `[dshow @ 000001c0...] `.
  const line = raw.replace(/^\s*\[[^\]]+\]\s*/, "").trim();
  const trailing = /^"([^"]+)"\s*\((video|audio)\)$/.exec(line);
  if (trailing) return trailing[1].trim();
  const wrapped = /audio="([^"]+)"/.exec(line);
  if (wrapped) return wrapped[1].trim();
  const unquoted = /^"?([^"]+?)"?\s*\((?:video|audio)\)$/.exec(line);
  return (unquoted?.[1] ?? line).trim();
}

/** Pulls audio input devices out of `ffmpeg -list_devices` output. */
export function parseDevices(stderr: string): AudioDevice[] {
  const out: AudioDevice[] = [];
  const seen = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    // Device lines carry the kind in parentheses; the "Alternative name" lines
    // that follow each device must not be mistaken for devices themselves.
    if (!/"[^"]*"\s*\((?:audio|video)\)/.test(line)) continue;
    if (/alternative name/i.test(line)) continue;
    // Only audio inputs are usable for dictation.
    if (!/"[^"]*"\s*\(audio\)/.test(line)) continue;
    const name = parseDeviceName(line);
    if (!name || seen.has(name)) continue;
    // Virtual and loopback entries DirectShow always lists are not microphones.
    if (/^(none|virtual|screen|wasapi loopback|audio input capture|virtual-audio-capturer)/i.test(name)) continue;
    seen.add(name);
    out.push({ name, label: name });
  }
  return out;
}

function run(cmd: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, _stdout, stderr) => {
      resolve(stderr || "");
    });
  });
}

/** Audio input devices available to ffmpeg. Empty when none can be listed. */
export async function listDevices(ffmpeg = "ffmpeg"): Promise<AudioDevice[]> {
  try {
    const stderr = await run(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    return parseDevices(stderr);
  } catch {
    return [];
  }
}

export interface RecorderHandle {
  readonly process: ChildProcess;
  /** Bytes written so far, for a duration estimate. */
  bytes(): number;
  /** ffmpeg's stderr, for diagnosing a device that will not open. */
  stderr(): string;
  /**
   * Latest RMS level, 0..1, averaged over recent samples. Drives the waveform
   * in the composer footer; computed from the stream we already receive so it
   * costs nothing extra.
   */
  level(): number;
  stop(): Promise<Buffer>;
}

/**
 * Starts recording mono 16 kHz PCM. Whisper wants 16 kHz anyway, so
 * converting here keeps the transcription step cheap.
 */
export function startRecording(opts: {
  ffmpeg: string;
  mic: string;
  sampleRate: number;
  maxSeconds: number;
  /** Amplification applied before transcription; 1 leaves the stream alone. */
  gain?: number;
  output: string;
}): RecorderHandle {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "dshow",
    // A small audio buffer keeps the capture on the microphone. The default
    // lets system audio bleed in, so the transcript becomes whatever the
    // speakers were playing.
    "-audio_buffer_size",
    "50",
    "-i",
    `audio=${opts.mic}`,
    "-ac",
    "1",
    "-ar",
    String(opts.sampleRate),
  ];
  if ((opts.gain ?? 1) > 1) args.push("-af", `volume=${opts.gain}`);
  args.push("-f", "s16le", "-");

  const child = spawn(opts.ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let total = 0;
  let rms = 0;
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  child.stdout?.on("data", (c: Buffer) => {
    total += c.length;
    chunks.push(Buffer.from(c));
    rms = Math.sqrt(
      c.reduce((sum, v) => sum + v * v, 0) / Math.max(1, c.length / 2),
    ) / 32768;
  });

  // ffmpeg needs a moment to open the device before it produces samples.
  // Stopping it in the same tick yields an empty capture, which looks
  // identical to a silent microphone and is very hard to debug later.
  let ready: Promise<void>;
  const started = new Promise<void>((resolve) => {
    const check = (): void => {
      if (total > 0) resolve();
      else if (child.exitCode !== null || stderr) resolve();
      else setTimeout(check, 60);
    };
    setTimeout(check, 60);
  });
  ready = started;

  const stopNow = (): Promise<Buffer> =>
    new Promise<Buffer>((resolve) => {
      void (async () => {
        if (autoStop) clearTimeout(autoStop);
        // Give the device a moment to open, bounded so a dead mic still
        // returns rather than hanging the command.
        await Promise.race([ready, new Promise((r) => setTimeout(r, 1200))]);
        child.once("close", () => resolve(Buffer.concat(chunks)));
        try {
          child.kill("SIGINT");
        } catch {
          child.kill();
        }
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            // already gone
          }
          resolve(Buffer.concat(chunks));
        }, 2000);
      })();
    });

  // ffmpeg's own -t ends the stream without us finalising the WAV header, so
  // the recording cap is enforced here instead.
  let autoStop: ReturnType<typeof setTimeout> | null = null;
  if (opts.maxSeconds > 0) {
    autoStop = setTimeout(() => {
      void stopNow();
    }, opts.maxSeconds * 1000);
    autoStop.unref?.();
  }

  return {
    process: child,
    bytes: () => total,
    level: () => rms,
    stderr: () => stderr,
    stop: stopNow,
  };
}

/**
 * Amplifies PCM so quiet microphones reach a level the transcriber can use.
 *
 * Capture hardware varies enormously: some microphones deliver a healthy
 * signal, others sit near 30/32767 and produce an empty transcript. Rather
 * than ask the user to fix Windows mixer levels, scale towards a target peak
 * and clamp so silence does not become noise.
 *
 * Returns the factor applied, so the UI can report it.
 */
export function normalizeGain(pcm: Buffer, target = 8000, maxFactor = 40): number {
  let peak = 0;
  for (let i = 0; i < pcm.length - 1; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  if (peak === 0) return 1;
  // Already healthy, or silence that must not be amplified into hiss.
  if (peak >= target) return 1;
  const factor = Math.min(maxFactor, target / peak);
  if (factor <= 1.05) return 1;
  applyGain(pcm, factor);
  return factor;
}

/** In-place PCM scaling with clamping. */
export function applyGain(pcm: Buffer, factor: number): void {
  if (factor === 1) return;
  for (let i = 0; i < pcm.length - 1; i += 2) {
    const v = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * factor)));
    pcm.writeInt16LE(v, i);
  }
}

/** Wraps raw mono PCM in a WAV header so whisper-cli can read it. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}