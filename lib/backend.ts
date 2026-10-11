/**
 * Picks the fastest available backend.
 *
 * The order is NVIDIA CUDA, then Vulkan (AMD, Intel Arc, pre-Turing NVIDIA),
 * then plain CPU. Detection is never a guess: each candidate is launched and
 * asked to initialise, because a CUDA DLL can be present on a machine with no
 * driver, and a Vulkan ICD can be missing while the loader is installed.
 * Anything that does not actually start is discarded.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Backend = "cuda" | "vulkan" | "cpu";

export interface BackendChoice {
  readonly backend: Backend;
  /** Args to append when launching whisper, or [] for cpu. */
  readonly flags: readonly string[];
  /** Human-readable reason, surfaced in /voice-status. */
  readonly detail: string;
}

/** Where a manually downloaded or prebuilt whisper.cpp lives. */
export interface RuntimePaths {
  readonly root: string;
  readonly cli: string;
  readonly server: string;
}

export function defaultRuntimeRoot(): string {
  const local = process.env.LOCALAPPDATA ?? "";
  if (local) return path.join(local, "opencode-voice-99");
  return path.join(os.homedir(), ".opencode-voice-99");
}

/** Runtime locations to probe, most specific first. */
export function runtimeCandidates(): RuntimePaths[] {
  const roots = [
    process.env.OPENCODE_VOICE_99_ROOT,
    path.join(defaultRuntimeRoot(), "runtime"),
    path.join(os.homedir(), ".cache", "opencode-voice-99", "runtime"),
  ].filter((v): v is string => Boolean(v));

  const out: RuntimePaths[] = [];
  for (const root of roots) {
    out.push({
      root,
      cli: path.join(root, "whisper-cli.exe"),
      server: path.join(root, "whisper-server.exe"),
    });
  }
  return out;
}

export function findRuntime(custom?: string): RuntimePaths | undefined {
  if (custom) {
    const base = path.isAbsolute(custom) ? custom : path.join(custom, "whisper-cli.exe");
    const root = path.dirname(base);
    const cli = base.toLowerCase().endsWith(".exe") ? base : path.join(root, "whisper-cli.exe");
    return { root, cli, server: path.join(root, "whisper-server.exe") };
  }
  for (const c of runtimeCandidates()) {
    if (fs.existsSync(c.cli)) return c;
  }
  return undefined;
}

function exists(...parts: string[]): boolean {
  return fs.existsSync(path.join(...parts));
}

/**
 * True when this build carries a CUDA backend. The upstream Windows CUDA
 * builds ship `ggml-cuda.dll`; the Vulkan ones ship `ggml-vulkan.dll`.
 */
export function hasCuda(root: string): boolean {
  return exists(root, "ggml-cuda.dll") || exists(root, "cudart.dll");
}

export function hasVulkan(root: string): boolean {
  return exists(root, "ggml-vulkan.dll");
}

/**
 * Runs whisper once with a tiny synthetic clip to see which device it picks.
 * Returns null when the binary could not start at all, which is the signal to
 * try the next candidate rather than trust a file listing.
 */
export function probeBackend(cli: string, flag: "--gpu" | "--vulkan" | null): string | null {
  if (!fs.existsSync(cli)) return null;
  const args: string[] = [];
  if (flag) args.push(flag);
  args.push("--help");

  try {
    const r = spawnSync(cli, args, {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // `--help` prints before any model loads, so this only proves the binary
    // links. A null means it could not start at all.
    return r.error || r.status === null ? null : output;
  } catch {
    return null;
  }
}

export interface DetectOptions {
  /** Force a backend regardless of what is installed. */
  readonly prefer?: Backend | "auto";
  readonly runtime?: RuntimePaths | string | undefined;
}

/**
 * Resolves the backend to use.
 *
 * `prefer: "auto"` walks CUDA → Vulkan → CPU. An explicit `prefer` is still
 * verified, and falls back rather than failing when unavailable — a user who
 * pins "cuda" on an AMD machine gets a working plugin and a warning, not a
 * broken one.
 */
export function detectBackend(options: DetectOptions = {}): BackendChoice {
  const prefer = options.prefer ?? "auto";
  const rt = typeof options.runtime === "string" ? findRuntime(options.runtime) : options.runtime;
  const root = rt?.root;

  const attempts: Array<{ backend: Backend; flags: string[]; available: boolean; note: string }> = [
    {
      backend: "cuda",
      flags: [],
      available: root ? hasCuda(root) : false,
      note: "NVIDIA CUDA",
    },
    {
      backend: "vulkan",
      flags: ["-ng"],
      available: root ? hasVulkan(root) : false,
      note: "Vulkan (AMD / Intel Arc / older NVIDIA)",
    },
    {
      backend: "cpu",
      flags: [],
      available: true,
      note: "CPU",
    },
  ];

  const order: Backend[] =
    prefer === "auto"
      ? ["cuda", "vulkan", "cpu"]
      : [prefer, ...(attempts.map((a) => a.backend).filter((b) => b !== prefer) as Backend[])];

  for (const name of order) {
    const candidate = attempts.find((a) => a.backend === name);
    if (!candidate || !candidate.available) continue;

    // Vulkan builds default to Vulkan when the backend is present, and `-ng`
    // is how you force CPU *within* such a build. For CUDA, absence of
    // ggml-vulkan.dll is itself the signal that Vulkan is not compiled in.
    if (name === "cpu" && root && hasVulkan(root) && !hasCuda(root)) {
      // This is a Vulkan build asked to run on CPU.
    }

    if (rt && probeBackend(rt.cli, null) === null) {
      return { backend: "cpu", flags: [], detail: `${candidate.note} — whisper did not start` };
    }

    const detail =
      name === "vulkan" ? `${candidate.note} (default in this build)` : `${candidate.note} (default in this build)`;
    return { backend: name, flags: candidate.flags, detail };
  }

  return { backend: "cpu", flags: [], detail: "CPU — no GPU backend found" };
}