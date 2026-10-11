import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBackend, findRuntime, hasCuda, hasVulkan } from "../lib/backend.ts";

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