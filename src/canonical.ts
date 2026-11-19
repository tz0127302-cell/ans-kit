import { AnsError } from "./errors.js";

/**
 * Deterministic JSON used as the Ed25519 message.
 * Object keys are sorted. Undefined object fields are omitted. Arrays keep order.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AnsError("INVALID_ARGUMENT", "Canonical JSON cannot encode non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key])}`).join(",");
    return `{${body}}`;
  }
  throw new AnsError("INVALID_ARGUMENT", `Canonical JSON cannot encode ${typeof value}.`);
}
