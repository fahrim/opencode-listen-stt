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
  output: string;
}): RecorderHandle {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "dshow",
    // Without this ffmpeg fails fast when the device name is slightly off.
    "-thread_queue_size",
    "1024",
    "-i",
    `audio=${opts.mic}`,
    "-t",
    String(opts.maxSeconds),
    "-ar",
    String(opts.sampleRate),
    "-ac",
    "1",
    "-f",
    "s16le",
    "-",
  ];

  const child = spawn(opts.ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let total = 0;
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  child.stdout?.on("data", (c: Buffer) => {
    total += c.length;
    chunks.push(Buffer.from(c));
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

  return {
    process: child,
    bytes: () => total,
    stop: () =>
      new Promise<Buffer>((resolve) => {
        void (async () => {
          // Give the device a moment to open, bounded so a dead mic still
          // returns rather than hanging the command.
          await Promise.race([
            ready,
            new Promise((r) => setTimeout(r, 1200)),
          ]);
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
      }),
    stderr: () => stderr,
  };
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