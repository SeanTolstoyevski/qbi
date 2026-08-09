
/** Matches a DNS label: lowercase alphanumeric + '-', 1-63 chars. */
export const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Matches a DNS subdomain: dot-separated DNS labels, ≤253 chars. */
export const DNS_SUBDOMAIN_RE =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** Valid characters for a Kubernetes label value, ≤63 chars. */
export const LABEL_VALUE_RE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

/**
 * Validate a Kubernetes object name (e.g. pod, deployment, service, secret).
 * Returns "" when valid, or a user-facing error message.
 */
export function validateName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "Name is required.";
  if (!DNS_LABEL_RE.test(trimmed)) {
    return "Name must be a lowercase DNS label (letters, digits and '-', up to 63 characters).";
  }
  if (trimmed.length > 63) {
    return "Name must be at most 63 characters.";
  }
  return "";
}

/**
 * Validate a Kubernetes qualified name (prefix/name), such as an annotation or
 * label key with an optional DNS prefix.
 * Returns "" when valid, or a user-facing error message.
 */
export function qualifiedNameError(key) {
  if (!key) return "";
  const parts = key.split("/");
  if (parts.length > 2) return `Key "${key}" has too many "/" separators.`;
  const name = parts[parts.length - 1];
  if (!DNS_LABEL_RE.test(name) || name.length > 63) {
    return `Key "${key}" is not a valid Kubernetes name.`;
  }
  if (parts.length === 2) {
    const prefix = parts[0];
    if (!DNS_SUBDOMAIN_RE.test(prefix) || prefix.length > 253) {
      return `Key prefix "${prefix}" is not a valid DNS name.`;
    }
  }
  return "";
}

/**
 * Validate a Kubernetes label value.
 * Returns "" when valid, or a user-facing error message.
 */
export function labelValueError(key, value) {
  if (!LABEL_VALUE_RE.test(value) || value.length > 63) {
    return `Label "${key}": value must be up to 63 characters of letters, digits, '-', '_' or '.'.`;
  }
  return "";
}
