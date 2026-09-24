import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Command Intent Abstraction
// ============================================================================

export type CommandIntent =
  | { kind: "direct"; argument: string }
  | { kind: "default" }
  | { kind: "state-explicit"; operation: string; argument?: string }
  | { kind: "invalid"; diagnostic: string };

// ============================================================================
// Reusable State Fallback Notification
// ============================================================================

export function notifyStateFallback(
  ctx: ExtensionCommandContext,
  command: string,
  directExample: string,
  stateExample: string
): void {
  const lines = [
    "Saved state is not available or invalid.",
    `Use \`${directExample}\` for a direct task,`,
    `or \`${stateExample}\` to run a saved plan.`,
  ];
  ctx.ui?.notify(lines.join("\n"), "warning");
}

// ============================================================================
// Command Parsers
// ============================================================================

/**
 * Parser for /build command
 * - "/build --from-plan" -> state-explicit
 * - "/build <task>"      -> direct (task argument is source of truth)
 * - "/build"             -> default (uses state if present, guidance otherwise)
 */
export function parseBuildIntent(args: string): CommandIntent {
  const trimmed = args.trim();
  if (!trimmed) {
    return { kind: "default" };
  }

  if (trimmed === "--from-plan" || trimmed.startsWith("--from-plan ")) {
    const subArg = trimmed.slice(11).trim();
    return {
      kind: "state-explicit",
      operation: "from-plan",
      argument: subArg || undefined,
    };
  }

  return { kind: "direct", argument: trimmed };
}

/**
 * Parser for /plan command
 * - "/plan approve"      -> state-explicit
 * - "/plan migrate"      -> state-explicit
 * - "/plan <goal>"       -> direct (goal argument is source of truth)
 * - "/plan"              -> default (summary of plan if present)
 */
export function parsePlanIntent(args: string): CommandIntent {
  const trimmed = args.trim();
  if (!trimmed) {
    return { kind: "default" };
  }

  const lower = trimmed.toLowerCase();
  if (lower === "approve" || lower.startsWith("approve ")) {
    return { kind: "state-explicit", operation: "approve" };
  }

  if (lower === "migrate" || lower.startsWith("migrate ")) {
    return { kind: "state-explicit", operation: "migrate" };
  }

  return { kind: "direct", argument: trimmed };
}

/**
 * Parser for /debug command
 * - "/debug <issue>" -> direct
 * - "/debug"         -> default
 */
export function parseDebugIntent(args: string): CommandIntent {
  const trimmed = args.trim();
  if (!trimmed) {
    return { kind: "default" };
  }
  return { kind: "direct", argument: trimmed };
}

/**
 * Parser for /review command
 * - "/review <target>" -> direct
 * - "/review"          -> default (active git diff)
 */
export function parseReviewIntent(args: string): CommandIntent {
  const trimmed = args.trim();
  if (!trimmed) {
    return { kind: "default" };
  }
  return { kind: "direct", argument: trimmed };
}

/**
 * Parser for /btw command
 * - "/btw <question>" -> direct
 * - "/btw"            -> default
 */
export function parseBtwIntent(args: string): CommandIntent {
  const trimmed = args.trim();
  if (!trimmed) {
    return { kind: "default" };
  }
  return { kind: "direct", argument: trimmed };
}

/**
 * Generic parser for future commands (e.g. /ship, /research)
 * - "<cmd> <arg>" -> direct
 * - "<cmd>"       -> default
 */
export function parseGenericDirectIntent(args: string): CommandIntent {
  const trimmed = args.trim();
  if (!trimmed) {
    return { kind: "default" };
  }
  return { kind: "direct", argument: trimmed };
}

export default function (_pi: ExtensionAPI) {
  // Command intent helper module
}
