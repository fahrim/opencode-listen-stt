/**
 * Manages a local whisper.cpp server.
 *
 * The server is started on demand, kept warm while in use, and unloaded after
 * an idle period so it does not sit on several hundred megabytes of VRAM. A
 * server this plugin did not start is never killed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectBackend, findRuntime, type BackendChoice, type RuntimePaths } from "./backend.ts";
import type { Voice99Config } from "./config.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Logs to the same place the STT plugin writes diagnostics. */
function log(...parts: unknown[]): void {
  try {
    const dir = path.join(process.env.LOCALAPPDATA ?? process.env.TMPDIR ?? ".", "opencode-voice-99");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "voice-99.log"), `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch {
    // Diagnostics must never break dictation.
  }
}

export class WhisperServer {
  private child?: ChildProcess;
  private owned = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private choice?: BackendChoice;

  private readonly cfg: Voice99Config;
  private readonly rt?: RuntimePaths;

  constructor(cfg: Voice99Config) {
    this.cfg = cfg;
    this.rt = findRuntime(this.cfg.runtime || undefined);
  }

  get backend(): BackendChoice {
    if (!this.choice) {
      this.choice = detectBackend({ prefer: this.cfg.backend, runtime: this.rt });
      log(`backend: ${this.choice.backend} (${this.choice.detail})`);
    }
    return this.choice;
  }

  baseURL(): string {
    return `http://127.0.0.1:${this.cfg.port}`;
  }

  /**
   * Transcriptions endpoint. whisper.cpp exposes the OpenAI-compatible handler
   * at `/inference`; `/v1/audio/transcriptions` is accepted as an alias by some
   * builds, so fall back to it if the first one 404s.
   */
  private endpoints(): string[] {
    return [`${this.baseURL()}/inference`, `${this.baseURL()}/v1/audio/transcriptions`];
  }

  private modelPath(): string {
    if (this.cfg.model) return this.cfg.model;
    const dir = path.join(path.dirname(this.rt?.root ?? "."), "models");
    const guess = path.join(dir, "ggml-large-v3-turbo-q5_0.bin");
    if (fs.existsSync(guess)) return guess;
    return "";
  }

  async ping(): Promise<boolean> {
    try {
      await fetch(`${this.baseURL()}/`, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  }

  async ensure(onStatus?: (message: string) => void): Promise<void> {
    if (this.starting) return this.starting;
    if (await this.ping()) return;
    this.starting = this.startServer(onStatus).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startServer(onStatus?: (message: string) => void): Promise<void> {
    if (!this.rt?.server || !fs.existsSync(this.rt.server)) {
      throw new Error(
        "whisper-server.exe not found. Run the installer, or set `runtime` in opencode-voice-99.json.",
      );
    }
    const model = this.modelPath();
    if (!model || !fs.existsSync(model)) {
      throw new Error(
        "No ggml model found. Download one, e.g. ggml-large-v3-turbo-q5_0.bin, and set `model` in opencode-voice-99.json.",
      );
    }

    const backend = this.backend;
    onStatus?.("loading model… (first run takes a few seconds)");

    const args = ["--model", model, "--host", "127.0.0.1", "--port", String(this.cfg.port)];
    if (this.cfg.language) args.push("--language", this.cfg.language);
    if (this.cfg.threads > 0) args.push("--threads", String(this.cfg.threads));

    log("spawn", this.rt.server, ...args, `| backend=${backend.backend}`);
    const child = spawn(this.rt.server, args, { windowsHide: true, stdio: "ignore" });
    this.child = child;
    this.owned = true;

    let exited = false;
    child.on("exit", (code) => {
      exited = true;
      log("server exited", String(code));
      if (this.child === child) this.child = undefined;
    });

    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error("whisper-server exited while starting — see voice-99.log");
      if (await this.ping()) {
        log("server ready");
        return;
      }
      await sleep(500);
    }
    throw new Error("timed out waiting for whisper-server");
  }

  async transcribe(wav: Buffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
    form.append("response_format", "json");
    // Always send the language. whisper auto-detects at roughly double the
    // cost, and mis-reads Turkish as English when it does.
    if (this.cfg.language) form.append("language", this.cfg.language);

    let lastError = "";
    for (const url of this.endpoints()) {
      const response = await fetch(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
      if (response.status === 404) {
        lastError = `${url} not found`;
        continue;
      }
      const body = await response.text();
      if (!response.ok) throw new Error(`transcription failed (${response.status}): ${body.slice(0, 200)}`);
      const parsed = JSON.parse(body) as { text?: string };
      this.scheduleIdleUnload();
      return (parsed.text ?? "").trim();
    }
    throw new Error(lastError || "no transcription endpoint answered");
  }

  /** Public: a cancelled recording still needs the model kept warm. */
  scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        if (this.owned && this.child) {
          log("idle unload");
          try {
            this.child.kill();
          } catch {
            // ignore
          }
        }
      },
      Math.max(1, this.cfg.idleMinutes) * 60_000,
    );
    this.idleTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.owned && this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
  }
}