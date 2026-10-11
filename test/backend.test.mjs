import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectBackend, findRuntime, hasCuda, hasVulkan } from "../lib/backend.ts";

test("an explicit directory is taken as the runtime root", () => {
  // Regression: a directory path used to be treated as a file path, which
  // silently resolved one level too high and then reported the server as
  // missing even though it was sitting right there.
  const dir = path.dirname(findRuntime().cli);
  const rt = findRuntime(dir);
  assert.equal(rt.root, dir);
  assert.equal(rt.server, path.join(dir, "whisper-server.exe"));
  assert.ok(fs.existsSync(rt.server), "the resolved server must exist on disk");
});

test("an explicit binary path resolves to its folder", () => {
  const rt = findRuntime();
  const fromExe = findRuntime(rt.cli);
  assert.equal(fromExe.root, rt.root);
  assert.equal(fromExe.server, rt.server);
});

test("finds a runtime under LOCALAPPDATA", () => {
  const rt = findRuntime();
  assert.ok(rt, "expected a runtime to be found on this machine");
  assert.ok(rt.server.endsWith("whisper-server.exe"));
});

test("detects the Vulkan backend from ggml-vulkan.dll", () => {
  const rt = findRuntime();
  assert.ok(rt);
  assert.equal(hasCuda(rt.root), false, "a Vulkan build has no CUDA dll");
  assert.equal(hasVulkan(rt.root), true);
  const choice = detectBackend({ runtime: rt });
  assert.equal(choice.backend, "vulkan");
});

test("falls back to CPU when no runtime is present", () => {
  const choice = detectBackend({ runtime: { root: "C:\\definitely\\not\\here", cli: "x.exe", server: "y.exe" } });
  assert.equal(choice.backend, "cpu");
});

test("an explicit backend preference is honoured when available", () => {
  const rt = findRuntime();
  assert.ok(rt);
  assert.equal(detectBackend({ runtime: rt, prefer: "vulkan" }).backend, "vulkan");
});

test("an unavailable preference degrades instead of failing", () => {
  const rt = findRuntime();
  assert.ok(rt);
  // This machine has no CUDA build; asking for it must not throw.
  const choice = detectBackend({ runtime: rt, prefer: "cuda" });
  assert.equal(choice.backend, "vulkan");
});