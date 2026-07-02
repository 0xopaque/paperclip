/**
 * Tests for the claude_local auth preflight gate.
 *
 * The gate reads a JSON auth-state file before spawning the CLI subprocess.
 * These tests exercise: missing file, invalid JSON, ok:false, store mismatch,
 * probe failure, expired token, and the happy path.
 *
 * All tests use CLAUDE_LOCAL_AUTH_STATE_PATH to override the default path so
 * no subprocess or real filesystem credentials are touched.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the subprocess runner so no real claude CLI is invoked ---
const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "result", session_id: "s-1", result: "OK", is_error: false,
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess };
});

import { execute, readClaudeLocalAuthGate } from "./execute.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1 hour

function validAuthState() {
  return {
    ok: true,
    reason: "ok_not_needed",
    checkedAt: new Date().toISOString(),
    notAfter: FUTURE_ISO,
    storesMatch: true,
    probe: { ok: true },
  };
}

function makeCtx(authStatePath: string): Parameters<typeof execute>[0] {
  return {
    runId: "run-test-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "test-agent",
    } as Parameters<typeof execute>[0]["agent"],
    runtime: {
      sessionId: null,
      sessionParams: {},
    } as Parameters<typeof execute>[0]["runtime"],
    config: {
      command: "claude",
      // No ANTHROPIC_API_KEY in env → billingType = "subscription"
    },
    context: {},
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
    executionTarget: null,
    // Pass the test-specific auth state file via the env override mechanism.
    // execute() reads process.env.CLAUDE_LOCAL_AUTH_STATE_PATH at runtime.
  } satisfies Parameters<typeof execute>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("claude_local auth preflight gate", () => {
  let tmpDir: string;
  let authStatePath: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-auth-gate-test-"));
    authStatePath = path.join(tmpDir, "claude-auth-state.json");
    originalEnv = process.env.CLAUDE_LOCAL_AUTH_STATE_PATH;
    process.env.CLAUDE_LOCAL_AUTH_STATE_PATH = authStatePath;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_LOCAL_AUTH_STATE_PATH;
    } else {
      process.env.CLAUDE_LOCAL_AUTH_STATE_PATH = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes through when auth state is valid and not expired (no CLI subprocess on gate)", async () => {
    // Gate passes → execute proceeds to CLI (which is mocked).
    await writeFile(authStatePath, JSON.stringify(validAuthState()), "utf-8");
    const result = await execute(makeCtx(authStatePath));
    // CLI subprocess ran: exit 0, no auth_preflight error.
    expect(result.errorCode).not.toBe("auth_preflight_failed");
    expect(result.errorFamily).not.toBe("auth_preflight");
  });

  it("returns auth_preflight_failed when auth state file is absent", async () => {
    // File does not exist at authStatePath.
    const result = await execute(makeCtx(authStatePath));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("auth_preflight_failed");
    expect(result.errorFamily).toBe("auth_preflight");
    expect(result.errorMessage).toContain("auth_state_missing");
    expect(result.clearSession).toBe(false);
    // No CLI subprocess should have been spawned.
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("returns auth_preflight_failed when ok is false in state file", async () => {
    await writeFile(
      authStatePath,
      JSON.stringify({ ...validAuthState(), ok: false, reason: "token_expired" }),
      "utf-8",
    );
    const result = await execute(makeCtx(authStatePath));
    expect(result.errorCode).toBe("auth_preflight_failed");
    expect(result.errorFamily).toBe("auth_preflight");
    expect(result.errorMessage).toContain("token_expired");
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("returns auth_preflight_failed when notAfter is in the past", async () => {
    const pastIso = new Date(Date.now() - 1000).toISOString();
    await writeFile(
      authStatePath,
      JSON.stringify({ ...validAuthState(), notAfter: pastIso }),
      "utf-8",
    );
    const result = await execute(makeCtx(authStatePath));
    expect(result.errorCode).toBe("auth_preflight_failed");
    expect(result.errorFamily).toBe("auth_preflight");
    expect(result.errorMessage).toContain("auth_state_expired");
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("returns auth_preflight_failed when probe.ok is false", async () => {
    await writeFile(
      authStatePath,
      JSON.stringify({ ...validAuthState(), probe: { ok: false } }),
      "utf-8",
    );
    const result = await execute(makeCtx(authStatePath));
    expect(result.errorCode).toBe("auth_preflight_failed");
    expect(result.errorFamily).toBe("auth_preflight");
    expect(result.errorMessage).toContain("auth_probe_not_ok");
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("returns auth_preflight_failed when storesMatch is false", async () => {
    await writeFile(
      authStatePath,
      JSON.stringify({ ...validAuthState(), storesMatch: false }),
      "utf-8",
    );
    const result = await execute(makeCtx(authStatePath));
    expect(result.errorCode).toBe("auth_preflight_failed");
    expect(result.errorFamily).toBe("auth_preflight");
    expect(result.errorMessage).toContain("auth_state_store_mismatch");
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("returns auth_preflight_failed when state file contains invalid JSON", async () => {
    await writeFile(authStatePath, "not-valid-json", "utf-8");
    const result = await execute(makeCtx(authStatePath));
    // JSON parse error surfaces as auth_state_missing (read failed) or auth_state_invalid.
    expect(result.errorCode).toBe("auth_preflight_failed");
    expect(result.errorFamily).toBe("auth_preflight");
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("populates resultJson with errorFamily and reason on gate failure", async () => {
    const result = await execute(makeCtx(authStatePath));
    expect(result.resultJson).toMatchObject({
      errorFamily: "auth_preflight",
      reason: "auth_state_missing",
    });
  });

  it("calls onMeta with authGate details on gate failure", async () => {
    const metaCalls: Parameters<NonNullable<Parameters<typeof execute>[0]["onMeta"]>>[] = [];
    const onMeta = vi.fn(async (...args: Parameters<NonNullable<Parameters<typeof execute>[0]["onMeta"]>>) => {
      metaCalls.push(args);
    });
    const ctx = { ...makeCtx(authStatePath), onMeta };
    await execute(ctx);
    expect(onMeta).toHaveBeenCalledOnce();
    expect(metaCalls[0]).toBeDefined();
    expect(metaCalls[0]![0].authGate).toMatchObject({ reason: "auth_state_missing" });
  });

  it("does NOT leak unknown auth-state file fields (e.g. tokens) into onMeta or resultJson", async () => {
    // The refresh mechanism could write extra fields; the gate must allowlist, not passthrough.
    await writeFile(
      authStatePath,
      JSON.stringify({
        ...validAuthState(),
        ok: false,
        reason: "token_expired",
        accessToken: "secret-token-should-never-surface",
        sessionId: "sess-should-never-surface",
        probe: { ok: false, rawResponse: "probe-secret-should-never-surface" },
      }),
      "utf-8",
    );
    const metaCalls: Parameters<NonNullable<Parameters<typeof execute>[0]["onMeta"]>>[] = [];
    const onMeta = vi.fn(async (...args: Parameters<NonNullable<Parameters<typeof execute>[0]["onMeta"]>>) => {
      metaCalls.push(args);
    });
    const result = await execute({ ...makeCtx(authStatePath), onMeta });

    const authGate = metaCalls[0]![0].authGate as Record<string, unknown>;
    expect(authGate).toMatchObject({ reason: "token_expired", ok: false, storesMatch: true });
    expect(authGate).not.toHaveProperty("accessToken");
    expect(authGate).not.toHaveProperty("sessionId");
    // probe is reconstructed to { ok } only — no nested secret survives.
    expect(authGate.probe).toEqual({ ok: false });

    const serialized = JSON.stringify({ meta: authGate, resultJson: result.resultJson });
    expect(serialized).not.toContain("should-never-surface");
  });

  it("gate is DORMANT when nothing is configured and the default file is absent (no regression for existing installs)", async () => {
    delete process.env.CLAUDE_LOCAL_AUTH_STATE_PATH;
    const missingDefault = path.join(tmpDir, "does-not-exist", "claude-auth-state.json");
    const gate = await readClaudeLocalAuthGate(undefined, missingDefault);
    expect(gate.ok).toBe(true);
    expect(gate.ok && gate.reason).toBe("unconfigured");
  });

  it("gate fails LOUDLY when an explicitly configured path is missing (misconfiguration is surfaced)", async () => {
    const gate = await readClaudeLocalAuthGate(path.join(tmpDir, "nope.json"));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe("auth_state_missing");
  });

  it("treats an empty CLAUDE_LOCAL_AUTH_STATE_PATH as unset, not as an explicit path", async () => {
    process.env.CLAUDE_LOCAL_AUTH_STATE_PATH = "";
    const missingDefault = path.join(tmpDir, "also-does-not-exist", "claude-auth-state.json");
    const gate = await readClaudeLocalAuthGate(undefined, missingDefault);
    expect(gate.ok).toBe(true);
  });
});
