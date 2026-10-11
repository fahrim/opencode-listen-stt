import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromRecord, shouldPinLanguage } from "../lib/config.ts";
import { pcmToWav, parseDeviceName, parseDevices } from "../lib/recorder.ts";

function withConfig(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v99-"));
  const file = path.join(dir, "opencode-voice-99.json");
  fs.writeFileSync(file, contents, "utf8");
  const previous = process.env.OPENCODE_VOICE_99_CONFIG;
  process.env.OPENCODE_VOICE_99_CONFIG = file;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_VOICE_99_CONFIG;
    else process.env.OPENCODE_VOICE_99_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

test("parses DirectShow device lines", () => {
  const stderr = [
    "[dshow @ 0000] DirectShow video devices (some may not be listed correctly)",
    'foo (2) (video)', 'audio="Headset Microphone" (audio)',
    'audio="Speakers" (audio)',
    'audio="none" (audio)',
  ].join("\n");
  const devices = parseDevices(stderr);
  assert.deepEqual(
    devices.map((d) => d.name),
    ["Headset Microphone", "Speakers"],
    "the virtual 'none' device must be filtered out",
  );
});

test("extracts a bare device name", () => {
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