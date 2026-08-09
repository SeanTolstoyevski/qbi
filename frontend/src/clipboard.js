
import { useStore } from "./store.js";

/**
 * Copy `text` to the system clipboard, then announce success or failure.
 *
 * @param {string} text  - The text to copy.
 * @param {string} label - Human-readable label for the announcement
 *                         (e.g. "Pod my-pod", "YAML preview").
 */
export async function copyToClipboard(text, label) {
  const { announce } = useStore();
  try {
    await navigator.clipboard.writeText(text);
    announce(`${label} copied to clipboard.`);
  } catch {
    announce("Copy failed.", "assertive");
  }
}
