import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Allowlist & Security Constants
// ============================================================================

export const DEFAULT_ALLOWLIST_HOSTS = new Set<string>([
  "127.0.0.1",
  "localhost",
]);

export const DEFAULT_ALLOWLIST_PORTS = new Set<string>([
  "20128",
]);

// ============================================================================
// Sanitization & Secret Redaction
// ============================================================================

export function sanitizeErrorMessage(message: string): string {
  if (!message) return "";
  return message
    .replace(/sk[_-][a-zA-Z0-9_-]{15,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9_.-]{15,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(?:password|secret|key)\s*[:=]\s*[^\s,;]+/gi, "secret: [REDACTED]")
    .replace(/(?:authorization|auth):\s*[^\r\n]+/gi, "authorization: [REDACTED]");
}

// ============================================================================
// URL & Endpoint Validation
// ============================================================================

export interface UrlValidationResult {
  valid: boolean;
  url?: URL;
  reason?: string;
}

export function isExternalOptInEnabled(): boolean {
  const envVal = process.env.PI_ALLOW_EXTERNAL_ENDPOINTS;
  return envVal === "1" || envVal === "true" || envVal === "yes";
}

export function validateEndpointUrl(
  rawUrl: string,
  allowExternal = false
): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { valid: false, reason: "Endpoint URL is empty or invalid" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Invalid URL format: ${msg}` };
  }

  // 1. Protocol must be HTTP or HTTPS only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      reason: `Protocol '${parsed.protocol}' is rejected. Only http: and https: protocols are permitted.`,
    };
  }

  // 2. Reject embedded credentials/secrets in URL
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reason: "URL rejected because it contains embedded credentials (username/password in URL).",
    };
  }

  // 3. Verify host allowlist
  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost = DEFAULT_ALLOWLIST_HOSTS.has(hostname);
  const effectiveAllowExternal = allowExternal || isExternalOptInEnabled();

  if (!isLocalhost && !effectiveAllowExternal) {
    return {
      valid: false,
      reason: `Host '${hostname}' is outside default local allowlist (127.0.0.1, localhost). External endpoints require explicit opt-in (PI_ALLOW_EXTERNAL_ENDPOINTS=1).`,
    };
  }

  return { valid: true, url: parsed };
}

// ============================================================================
// Secret Resolution (Environment Variable First)
// ============================================================================

export interface ResolvedSecret {
  apiKey?: string;
  source: "env" | "config" | "none";
  sourceName?: string;
}

export function resolveSecureApiKey(): ResolvedSecret {
  // 1. Prioritize environment variables
  const envKeys = [
    "PI_9ROUTER_API_KEY",
    "NINE_ROUTER_API_KEY",
    "PI_BTW_API_KEY",
    "PI_TITLE_API_KEY",
  ];

  for (const envName of envKeys) {
    const val = process.env[envName];
    if (val && val.trim().length > 0) {
      return {
        apiKey: val.trim(),
        source: "env",
        sourceName: envName,
      };
    }
  }

  // 2. Read local config file if present (without mutating old keys)
  try {
    const configPath = path.join(os.homedir(), ".pi", "agent", "9router-config.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0) {
        return {
          apiKey: cfg.apiKey.trim(),
          source: "config",
          sourceName: "~/.pi/agent/9router-config.json",
        };
      }
    }
  } catch {}

  return { source: "none" };
}

// ============================================================================
// Secure Fetch With Redirect Guards and Full-Lifecycle Timeout
// ============================================================================

export interface SafePostJsonOptions {
  timeoutMs?: number;
  externalSignal?: AbortSignal;
  allowExternal?: boolean;
}

export async function safePostJson<T = unknown>(
  rawUrl: string,
  payload: unknown,
  apiKey?: string,
  options: SafePostJsonOptions = {}
): Promise<{ success: boolean; data?: T; error?: string }> {
  // 1. Validate URL and Host
  const validation = validateEndpointUrl(rawUrl, options.allowExternal);
  if (!validation.valid || !validation.url) {
    return { success: false, error: validation.reason || "Invalid URL" };
  }

  const targetUrl = validation.url;
  const timeoutMs = options.timeoutMs ?? 10000;
  const internalController = new AbortController();

  const onExternalAbort = () => internalController.abort();
  if (options.externalSignal) {
    if (options.externalSignal.aborted) {
      return { success: false, error: "Request was cancelled." };
    }
    options.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      internalController.abort();
      reject(new Error("Request exceeded overall timeout deadline."));
    }, timeoutMs);
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const fetchPromise = (async () => {
      // redirect: "manual" to detect and block cross-host redirects
      const res = await fetch(targetUrl.href, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: internalController.signal,
      });

      // Handle redirect status (301, 302, 307, 308)
      if (res.status >= 300 && res.status < 400) {
        const redirectLocation = res.headers.get("location");
        if (redirectLocation) {
          try {
            const redirectUrl = new URL(redirectLocation, targetUrl.href);
            // Reject cross-origin redirect
            if (redirectUrl.origin !== targetUrl.origin) {
              throw new Error(
                `Cross-origin redirect from ${targetUrl.host} to ${redirectUrl.host} was blocked for security.`
              );
            }
          } catch {
            throw new Error("Redirect with invalid location was blocked.");
          }
        } else {
          throw new Error("Redirect status without valid location header was blocked.");
        }
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return (await res.json()) as T;
    })();

    const result = await Promise.race([fetchPromise, timeoutPromise]);
    return { success: true, data: result };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = sanitizeErrorMessage(rawMsg);
    const isAborted = internalController.signal.aborted || (options.externalSignal?.aborted ?? false);
    return {
      success: false,
      error: isAborted ? "Request was cancelled or timed out." : sanitizedMsg,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (options.externalSignal) {
      options.externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ============================================================================
// Plaintext Secret Audit Helper
// ============================================================================

export interface SecretAuditFinding {
  filePath: string;
  keyDescription: string;
  recommendation: string;
}

export function auditPlaintextSecrets(cwd: string): SecretAuditFinding[] {
  const findings: SecretAuditFinding[] = [];
  const agentDir = path.join(os.homedir(), ".pi", "agent");

  // 1. Inspect 9router-config.json
  const routerCfgPath = path.join(agentDir, "9router-config.json");
  if (fs.existsSync(routerCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(routerCfgPath, "utf8"));
      if (typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0) {
        findings.push({
          filePath: routerCfgPath,
          keyDescription: "Plaintext 'apiKey' field detected",
          recommendation: "Move API key to environment variable PI_9ROUTER_API_KEY",
        });
      }
    } catch {}
  }

  // 2. Inspect models.json
  const modelsPath = path.join(agentDir, "models.json");
  if (fs.existsSync(modelsPath)) {
    try {
      const modelsCfg = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
      if (modelsCfg && typeof modelsCfg.providers === "object") {
        for (const [pName, pObj] of Object.entries(modelsCfg.providers as Record<string, any>)) {
          if (typeof pObj?.apiKey === "string" && !pObj.apiKey.startsWith("$") && !pObj.apiKey.startsWith("!")) {
            findings.push({
              filePath: modelsPath,
              keyDescription: `Provider '${pName}' stores literal plaintext 'apiKey'`,
              recommendation: `Use environment variable like '\$${pName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY'`,
            });
          }
        }
      }
    } catch {}
  }

  // 3. Inspect active-plan.json
  const planPath = path.join(path.resolve(cwd), ".pi", "active-plan.json");
  if (fs.existsSync(planPath)) {
    try {
      const raw = fs.readFileSync(planPath, "utf8");
      if (/sk[_-][a-zA-Z0-9_-]{15,}/.test(raw) || /Bearer\s+[a-zA-Z0-9_.-]{15,}/i.test(raw)) {
        findings.push({
          filePath: planPath,
          keyDescription: "Token or key pattern detected in active plan file",
          recommendation: "Clean .pi/active-plan.json of secret tokens",
        });
      }
    } catch {}
  }

  return findings;
}

// ============================================================================
// Extension Commands Registration
// ============================================================================

export default function (pi: ExtensionAPI) {
  // /security-status: Display security posture without exposing secrets
  pi.registerCommand("security-status", {
    description: "Display security posture, endpoint allowlist, and credential source",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const secret = resolveSecureApiKey();
      const allowExternal = isExternalOptInEnabled();

      const defaultEndpoints = Array.from(DEFAULT_ALLOWLIST_HOSTS).map(
        (h) => `http://${h}:20128 (Default Allowlist)`
      );

      const secretStatus =
        secret.source === "env"
          ? `Configured via Environment Variable (${secret.sourceName}) [SECURE]`
          : secret.source === "config"
          ? `Stored in ${secret.sourceName} [NOT RECOMMENDED, move to PI_9ROUTER_API_KEY]`
          : "Not configured";

      const lines = [
        "=== SECURITY POSTURE & NETWORK GUARD ===",
        `Secret Policy       : Plaintext secrets rejected from logs/transcript/state`,
        `API Key Source      : ${secretStatus}`,
        `External Endpoints  : ${allowExternal ? "OPT-IN ACTIVE (PI_ALLOW_EXTERNAL_ENDPOINTS=1)" : "DISABLED (Only localhost permitted)"}`,
        `Network Redirect    : Manual check active (Cross-origin redirects blocked)`,
        `Default Allowlist   :`,
        ...defaultEndpoints.map((ep) => `  - ${ep}`),
        `Error Sanitization  : Active (Tokens and Authorization headers redacted)`,
        `Audit Command       : Run /security-check to scan for plaintext keys`,
      ].join("\n");

      ctx.ui?.notify(lines, "info");
    },
  });

  // /security-check: Scan configuration files for plaintext keys
  pi.registerCommand("security-check", {
    description: "Scan configuration files for plaintext keys without printing their values",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const findings = auditPlaintextSecrets(ctx.cwd);

      if (findings.length === 0) {
        ctx.ui?.notify(
          "Security Check: CLEAN. No plaintext keys detected in config files or active plan.",
          "info"
        );
        return;
      }

      const reportLines = [
        `[SECURITY AUDIT] Found ${findings.length} plaintext key finding(s):`,
        ...findings.map(
          (f, idx) =>
            `${idx + 1}. ${path.basename(f.filePath)}:\n   Issue: ${f.keyDescription}\n   Advice: ${f.recommendation}`
        ),
      ];

      ctx.ui?.notify(reportLines.join("\n"), "warning");
    },
  });
}
