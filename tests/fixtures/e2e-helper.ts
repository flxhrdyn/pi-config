import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

export interface ResolvedPiRuntime {
  runtimePath: string;
  version: string;
}

/**
 * Resolusi path modul Pi runtime lokal tanpa hardcode path release.
 * Mendukung environment variable PI_E2E_RUNTIME sebagai override.
 */
export function resolvePiRuntime(): ResolvedPiRuntime | null {
  if (process.env.PI_E2E_RUNTIME && fs.existsSync(process.env.PI_E2E_RUNTIME)) {
    return {
      runtimePath: process.env.PI_E2E_RUNTIME,
      version: "custom-env",
    };
  }

  const homeDir = os.homedir();
  const currentFile = path.join(homeDir, ".pi", "agent", "install", "current-version");

  if (fs.existsSync(currentFile)) {
    try {
      const ver = fs.readFileSync(currentFile, "utf8").trim();
      if (ver) {
        const candidate = path.join(
          homeDir,
          ".pi",
          "agent",
          "install",
          "releases",
          ver,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "index.js"
        );
        if (fs.existsSync(candidate)) {
          return {
            runtimePath: candidate,
            version: ver,
          };
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Memuat modul Pi SDK secara dinamis.
 */
export async function loadPiSdk(): Promise<any> {
  const resolved = resolvePiRuntime();
  if (!resolved) {
    return null;
  }
  return await import(pathToFileURL(resolved.runtimePath).href);
}

/**
 * Membuat direktori fixture sementara untuk pengujian E2E yang terisolasi.
 */
export function createFixtureProject(prefix = "pi-e2e-fixture-"): {
  dir: string;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  // Inisialisasi struktur dasar proyek
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({ name: "test-fixture-project", version: "1.0.0" }, null, 2),
    "utf8"
  );

  return {
    dir: tempDir,
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/**
 * Redaksi string rahasia dari teks log/output
 */
export function redactSecrets(output: string): string {
  if (!output) return "";
  return output
    .replace(/sk[_-][a-zA-Z0-9_-]{15,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9_.-]{15,}/gi, "Bearer [REDACTED_TOKEN]");
}
