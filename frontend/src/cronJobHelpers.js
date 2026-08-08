/*
 * Shared helpers and constants for CronJob forms (Create / Edit).
 */

export const CONCURRENCY_POLICIES = [
  { value: "Allow", label: "Allow (may overlap)" },
  { value: "Forbid", label: "Forbid (singleton)" },
  { value: "Replace", label: "Replace (cancel running)" },
];

export const SCHEDULE_ERROR =
  'Schedule must be a 5-field cron expression, e.g. "0 * * * *".';

/**
 * A cron schedule is exactly five whitespace-separated fields.
 * Returns `true` when `s` is a non-empty string with exactly 5 fields.
 *
 * Accepts leading/trailing whitespace (the form trims before submission).
 *
 * Examples:
 *   validSchedule("0 * * * *")          → true
 *   validSchedule("  0 * * * *  ")      → true
 *   validSchedule("5,10 * * * *")         → true
 *   validSchedule("* * * *")            → false (4 fields)
 *   validSchedule("")                   → false
 *   validSchedule(null)                 → false
 *   validSchedule(undefined)            → false
 */
export function validSchedule(s) {
  if (s == null) return false;
  const trimmed = String(s).trim();
  if (!trimmed) return false;
  return /^(\S+\s+){4}\S+$/.test(trimmed);
}

/**
 * Split a space-separated command string into an array of tokens.
 * Returns [] for empty/whitespace-only input.
 *
 * Examples:
 *   splitCommand("echo hello")    → ["echo", "hello"]
 *   splitCommand("  one   two  ") → ["one", "two"]
 *   splitCommand("")              → []
 *   splitCommand(null)            → []
 */
export function splitCommand(s) {
  if (s == null) return [];
  const str = String(s).trim();
  return str ? str.split(/\s+/) : [];
}
