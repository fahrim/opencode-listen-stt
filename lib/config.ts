/**
 * Settings: built-in defaults, overridden by `~/.config/opencode/opencode-listen-stt.json`,
 * overridden again by plugin options. Unknown or wrongly-typed values are
 * ignored so a typo in a settings file cannot stop the plugin loading.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Backend } from "./backend.ts";

export interface ListenSttConfig {
  ffmpeg: string;
  /** whisper.cpp install root, or "" to auto-detect. */
  runtime: string;
  model: string;
  port: number;
  /** GPU backend; "auto" probes CUDA then Vulkan then CPU. */
  backend: Backend | "auto";
  /** Spoken language hint. Always send it: "auto" doubles transcription time
   *  and mis-detects Turkish as English. */
  language: string;
  threads: number;
  idleMinutes: number;
  maxSeconds: number;
  sampleRate: number;
  hotkey: string;
  mic: string;
}

export const DEFAULTS: ListenSttConfig = {
  ffmpeg: "ffmpeg",
  runtime: "",
  model: "",
  port: 8801,
  backend: "auto",
  language: "auto",
  threads: 0,
  idleMinutes: 10,
  maxSeconds: 300,
  sampleRate: 16000,
  hotkey: "ctrl+y",
  mic: "",
};

export function configFilePath(): string {
  if (process.env.OPENCODE_LISTEN_STT_CONFIG?.trim()) return process.env.OPENCODE_LISTEN_STT_CONFIG.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
  return path.join(base, "opencode-listen-stt.json");
}

export function readConfigFile(): Partial<ListenSttConfig> {
  try {
    const file = configFilePath();
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return fromRecord(raw);
  } catch {
    return {};
  }
}

export function fromRecord(raw: Record<string, unknown>): Partial<ListenSttConfig> {
  const out: Partial<ListenSttConfig> = {};
  const str = (k: keyof ListenSttConfig) => {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim() as never;
  };
  const num = (k: keyof ListenSttConfig, allowZero = false) => {
    const v = raw[k];
    const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
    if (Number.isFinite(n) && (allowZero || n > 0)) out[k] = n as never;
  };

  str("ffmpeg");
  str("runtime");
  str("model");
  str("language");
  str("hotkey");
  if (typeof raw.mic === "string") out.mic = raw.mic.trim();
  if (raw.backend === "cuda" || raw.backend === "vulkan" || raw.backend === "cpu" || raw.backend === "auto") {
    out.backend = raw.backend;
  }
  num("port");
  num("threads", true);
  num("idleMinutes");
  num("maxSeconds");
  num("sampleRate");
  return out;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function num(value: unknown, fallback: number, allowZero = false): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && (allowZero || n > 0) ? n : fallback;
}

export function configFromOptions(options: Readonly<Record<string, unknown>> | undefined): ListenSttConfig {
  const merged: Record<string, unknown> = { ...readConfigFile(), ...(options ?? {}) };
  return {
    ffmpeg: str(merged.ffmpeg, DEFAULTS.ffmpeg),
    runtime: str(merged.runtime, DEFAULTS.runtime),
    model: str(merged.model, DEFAULTS.model),
    port: num(merged.port, DEFAULTS.port),
    backend:
      merged.backend === "cuda" || merged.backend === "vulkan" || merged.backend === "cpu" || merged.backend === "auto"
        ? merged.backend
        : DEFAULTS.backend,
    language: str(merged.language, DEFAULTS.language),
    threads: num(merged.threads, DEFAULTS.threads, true),
    idleMinutes: num(merged.idleMinutes, DEFAULTS.idleMinutes),
    maxSeconds: num(merged.maxSeconds, DEFAULTS.maxSeconds),
    sampleRate: num(merged.sampleRate, DEFAULTS.sampleRate),
    hotkey: str(merged.hotkey, DEFAULTS.hotkey),
    mic: str(merged.mic, DEFAULTS.mic),
  };
}

/** Languages offered by the picker. The engine supports 99; these are common. */
export const LANGUAGES: Readonly<Record<string, string>> = {
  auto: "Auto-detect (slower, less accurate for Turkish)",
  tr: "Türkçe (Turkish)",
  en: "English",
  de: "Deutsch (German)",
  fr: "Français (French)",
  es: "Español (Spanish)",
  it: "Italiano (Italian)",
  pt: "Português (Portuguese)",
  nl: "Nederlands (Dutch)",
  ru: "Русский (Russian)",
  uk: "Українська (Ukrainian)",
  pl: "Polski (Polish)",
  ja: "日本語 (Japanese)",
  ko: "한국어 (Korean)",
  zh: "中文 (Chinese)",
  ar: "العربية (Arabic)",
  hi: "हिन्दी (Hindi)",
  sv: "Svenska (Swedish)",
};

/**
 * True when the configured language is one where auto-detection is a poor
 * trade. Turkish is the common case that motivated the setting: whisper reads
 * a Turkish recording as English and returns Latin-script nonsense.
 */
export function shouldPinLanguage(language: string): boolean {
  return Boolean(language) && language !== "auto";
}