import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import securityGuardExtension, {
  validateEndpointUrl,
  resolveSecureApiKey,
  sanitizeErrorMessage,
  auditPlaintextSecrets,
  safePostJson,
  DEFAULT_ALLOWLIST_HOSTS,
} from "../extensions/security-guard.js";

describe("Task 2: Security Guard & Network Policy Tests", () => {
  const originalEnv = { ...process.env };
  let testCwd: string;
  let mockUi: { notify: ReturnType<typeof vi.fn> };
  let mockPi: any;
  let commands: Record<string, Function>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PI_ALLOW_EXTERNAL_ENDPOINTS;
    delete process.env.PI_9ROUTER_API_KEY;
    delete process.env.NINE_ROUTER_API_KEY;

    commands = {};
    mockUi = { notify: vi.fn() };
    mockPi = {
      registerCommand: vi.fn((name: string, def: any) => {
        commands[name] = def.handler;
      }),
      on: vi.fn(),
    };

    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-security-test-"));
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      fs.rmSync(testCwd, { recursive: true, force: true });
    } catch {}
  });

  describe("URL Validation & Host Allowlist", () => {
    it("accepts default localhost allowlist endpoints", () => {
      expect(validateEndpointUrl("http://127.0.0.1:20128").valid).toBe(true);
      expect(validateEndpointUrl("http://localhost:20128").valid).toBe(true);
      expect(validateEndpointUrl("http://127.0.0.1:20128/v1/chat").valid).toBe(true);
    });

    it("rejects invalid URL formats", () => {
      expect(validateEndpointUrl("").valid).toBe(false);
      expect(validateEndpointUrl("not-a-valid-url").valid).toBe(false);
    });

    it("rejects protocols other than http and https", () => {
      const ftpRes = validateEndpointUrl("ftp://localhost:20128/v1");
      expect(ftpRes.valid).toBe(false);
      expect(ftpRes.reason).toContain("Only http: and https: protocols are permitted");

      const fileRes = validateEndpointUrl("file:///etc/passwd");
      expect(fileRes.valid).toBe(false);

      const jsRes = validateEndpointUrl("javascript:alert(1)");
      expect(jsRes.valid).toBe(false);
    });

    it("rejects URLs with embedded credentials or secrets", () => {
      const credRes = validateEndpointUrl("http://user:secret123@localhost:20128/v1");
      expect(credRes.valid).toBe(false);
      expect(credRes.reason).toContain("embedded credentials");

      const userOnly = validateEndpointUrl("http://admin@localhost:20128/v1");
      expect(userOnly.valid).toBe(false);
    });

    it("rejects external non-localhost hosts by default without opt-in", () => {
      const extRes = validateEndpointUrl("https://api.external-ai.com/v1");
      expect(extRes.valid).toBe(false);
      expect(extRes.reason).toContain("default local allowlist");
      expect(extRes.reason).toContain("PI_ALLOW_EXTERNAL_ENDPOINTS=1");
    });

    it("allows external hosts only with explicit opt-in", () => {
      // 1. Via function parameter
      const resWithParam = validateEndpointUrl("https://api.external-ai.com/v1", true);
      expect(resWithParam.valid).toBe(true);

      // 2. Via environment variable
      process.env.PI_ALLOW_EXTERNAL_ENDPOINTS = "1";
      const resWithEnv = validateEndpointUrl("https://api.external-ai.com/v1", false);
      expect(resWithEnv.valid).toBe(true);
    });
  });

  describe("Secret Resolution & Redaction", () => {
    it("prioritizes environment variables over config files", () => {
      process.env.PI_9ROUTER_API_KEY = "env-secret-key-12345";
      const resolved = resolveSecureApiKey();
      expect(resolved.source).toBe("env");
      expect(resolved.sourceName).toBe("PI_9ROUTER_API_KEY");
      expect(resolved.apiKey).toBe("env-secret-key-12345");
    });

    it("sanitizes error messages by redacting tokens and secrets", () => {
      const rawError = "Request failed for sk_live_abcdef123456789012345 with Bearer token_secret_1234567890 and password=secretpass";
      const sanitized = sanitizeErrorMessage(rawError);

      expect(sanitized).not.toContain("sk_live_abcdef123456789012345");
      expect(sanitized).not.toContain("token_secret_1234567890");
      expect(sanitized).not.toContain("secretpass");
      expect(sanitized).toContain("[REDACTED_API_KEY]");
      expect(sanitized).toContain("[REDACTED_TOKEN]");
      expect(sanitized).toContain("secret: [REDACTED]");
    });
  });

  describe("Safe POST with Redirect Blocking", () => {
    it("rejects non-allowlisted hosts before making any network call", async () => {
      const result = await safePostJson("https://arbitrary-untrusted-site.com/v1", { prompt: "hi" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("allowlist");
    });
  });

  describe("Security Audit & Commands", () => {
    it("registers /security-status and /security-check", () => {
      securityGuardExtension(mockPi);
      expect(commands["security-status"]).toBeDefined();
      expect(commands["security-check"]).toBeDefined();
    });

    it("/security-status displays posture without exposing secret values", async () => {
      securityGuardExtension(mockPi);
      process.env.PI_9ROUTER_API_KEY = "super-secret-production-key-999";

      const ctx: any = { cwd: testCwd, ui: mockUi };
      await commands["security-status"]("", ctx);

      expect(mockUi.notify).toHaveBeenCalled();
      const output = mockUi.notify.mock.calls[0][0];

      // Must NOT leak secret value
      expect(output).not.toContain("super-secret-production-key-999");
      expect(output).toContain("PI_9ROUTER_API_KEY");
      expect(output).toContain("Default Allowlist");
    });

    it("/security-check detects plaintext keys and reports file without printing secret", async () => {
      securityGuardExtension(mockPi);
      const planDir = path.join(testCwd, ".pi");
      fs.mkdirSync(planDir, { recursive: true });

      // Create a plan with a leaked token
      fs.writeFileSync(
        path.join(planDir, "active-plan.json"),
        JSON.stringify({
          schemaVersion: 1,
          goal: "connect using sk_live_test_secret_leak_12345",
        }),
        "utf8"
      );

      const findings = auditPlaintextSecrets(testCwd);
      expect(findings.length).toBeGreaterThan(0);

      // Verify recommendation does not print the secret itself
      for (const f of findings) {
        expect(f.recommendation).not.toContain("sk_live_test_secret_leak_12345");
        expect(f.keyDescription).not.toContain("sk_live_test_secret_leak_12345");
      }

      const ctx: any = { cwd: testCwd, ui: mockUi };
      await commands["security-check"]("", ctx);
      expect(mockUi.notify).toHaveBeenCalled();
      const report = mockUi.notify.mock.calls[0][0];
      expect(report).not.toContain("sk_live_test_secret_leak_12345");
      expect(report).toContain("active-plan.json");
    });
  });
});
