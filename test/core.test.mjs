import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromRecord, shouldPinLanguage } from "../lib/config.ts";
import { pcmRms, pcmToWav, parseDeviceName, parseDevices } from "../lib/recorder.ts";

/** Builds signed 16-bit little-endian PCM holding a sine of `amplitude`. */
function sinePcm(amplitude, samples = 512) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * i) / 32)), i * 2);
  }
  return buf;
}

function withConfig(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v99-"));
  const file = path.join(dir, "opencode-listen-stt.json");
  fs.writeFileSync(file, contents, "utf8");
  const previous = process.env.OPENCODE_LISTEN_STT_CONFIG;
  process.env.OPENCODE_LISTEN_STT_CONFIG = file;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_LISTEN_STT_CONFIG;
    else process.env.OPENCODE_LISTEN_STT_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("meter level tracks loudness instead of sitting flat", () => {
  const quiet = pcmRms(sinePcm(400));
  const normal = pcmRms(sinePcm(4000));
  const loud = pcmRms(sinePcm(20000));

  // The bug this guards against summed raw bytes rather than signed 16-bit
  // samples, which returned nearly the same number for all three and left the
  // waveform looking like a dead microphone.
  assert.ok(
    normal > quiet * 4,
    `a 10x louder signal must read clearly higher (quiet ${quiet}, normal ${normal})`,
  );
  assert.ok(
    loud > normal * 4,
    `a 5x louder signal must read clearly higher (normal ${normal}, loud ${loud})`,
  );
  assert.ok(loud <= 1, "level must stay inside 0..1");
});

test("meter level is zero for silence and empty buffers", () => {
  assert.equal(pcmRms(Buffer.alloc(4096)), 0);
  assert.equal(pcmRms(Buffer.alloc(0)), 0);
});

test("meter level matches the amplitude it was given", () => {
  // A sine's RMS is amplitude / sqrt(2); allow a little slack for rounding.
  const level = pcmRms(sinePcm(16000));
  assert.ok(level > 0.34 && level < 0.37, `expected about 0.354, got ${level}`);
});

test("reads valid values from the settings file", () => {
  withConfig(
    JSON.stringify({ language: "tr", threads: 8, backend: "vulkan", port: 9000, mic: "Headset" }),
    () => {
      const c = fromRecord({ language: "tr", threads: 8, backend: "vulkan", port: 9000, mic: "Headset" });
      assert.equal(c.language, "tr");
      assert.equal(c.threads, 8);
      assert.equal(c.backend, "vulkan");
      assert.equal(c.port, 9000);
      assert.equal(c.mic, "Headset");
    },
  );
});

test("ignores wrongly typed and unknown keys", () => {
  const c = fromRecord({ threads: "eight", port: -5, backend: "quantum", nonsense: true, rate: 999 });
  assert.equal(c.threads, undefined, "a non-numeric thread count must not be accepted");
  assert.equal(c.port, undefined, "a negative port must not be accepted");
  assert.equal(c.backend, undefined, "an unknown backend must not be accepted");
});

test("zero threads is allowed so it can mean auto", () => {
  const c = fromRecord({ threads: 0 });
  assert.equal(c.threads, 0);
});

test("marks every language except auto as worth pinning", () => {
  assert.equal(shouldPinLanguage("auto"), false);
  assert.equal(shouldPinLanguage("tr"), true);
  assert.equal(shouldPinLanguage(""), false);
});

// Captured from `ffmpeg -list_devices true -f dshow -i dummy` on Windows 11.
// The real format puts the quoted name first and the kind last, which is the
// opposite of the audio="..." form this test originally assumed.
const REAL_FFMPEG_OUTPUT = [
  '[dshow @ 000001c0b01b5780] "Iriun Webcam" (video)',
  '[dshow @ 000001c0b01b5780]   Alternative name "@device_pnp_\\\\root#camera#0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}"',
  '[dshow @ 000001c0b01b5780] "Nikon Webcam Utility" (none)',
  '[dshow @ 000001c0b01b5780] "OBS Virtual Camera" (video)',
  '[dshow @ 000001c0b01b5780] "Mikrofon (8- FUJIN)" (audio)',
  '[dshow @ 000001c0b01b5780]   Alternative name "@device_cm_{33D9A762}\\wave_{CD6DFF92}"',
  '[dshow @ 000001c0b01b5780] "virtual-audio-capturer" (audio)',
  '[dshow @ 000001c0b01b5780] "Mikrofon (Realtek(R) Audio)" (audio)',
  '[dshow @ 000001c0b01b5780] "Mikrofon (Iriun Webcam)" (audio)',
  "Error opening input file dummy.",
].join("\n");

test("parses the real ffmpeg device listing", () => {
  const devices = parseDevices(REAL_FFMPEG_OUTPUT);
  assert.deepEqual(
    devices.map((d) => d.name),
    ["Mikrofon (8- FUJIN)", "Mikrofon (Realtek(R) Audio)", "Mikrofon (Iriun Webcam)"],
    "only audio inputs, no video, no alternative-name lines, no virtual capture",
  );
});

test("also accepts the audio=\"...\" form", () => {
  const devices = parseDevices('foo (2) (video)  audio="Headset Microphone" (audio)');
  assert.deepEqual(devices.map((d) => d.name), ["Headset Microphone"]);
});

test("parses the real quoted-name form", () => {
  assert.equal(parseDeviceName('[dshow @ 0000] "Mikrofon (Realtek(R) Audio)" (audio)'), "Mikrofon (Realtek(R) Audio)");
  assert.equal(parseDeviceName('audio="Microphone (2- USB)" (audio)'), "Microphone (2- USB)");
});

test("builds a wav header with matching sizes", () => {
  const pcm = Buffer.alloc(3200, 7);
  const wav = pcmToWav(pcm, 16000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data chunk size must match the payload");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "RIFF size must account for the header");
  assert.equal(wav.readUInt16LE(22), 1, "must be mono");
  assert.equal(wav.readUInt32LE(24), 16000);
});