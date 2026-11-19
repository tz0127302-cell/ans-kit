export const ANS_ERROR_CODES = [
  "USAGE",
  "INVALID_ARGUMENT",
  "INVALID_NAME",
  "INVALID_KEY",
  "INVALID_SIGNATURE",
  "SIGNATURE_INVALID",
  "ASSERTION_INVALID",
  "EXPIRED",
  "AUDIENCE_MISMATCH",
  "KEY_MISMATCH",
  "PIN_MISMATCH",
  "ALREADY_REGISTERED",
  "ALREADY_EXISTS",
  "ALREADY_INITIALIZED",
  "NOT_FOUND",
  "NOT_INITIALIZED",
  "REGISTRY_CORRUPT",
  "REGISTRY_BUSY",
  "PUBLIC_REGISTRY_UNAVAILABLE",
  "REMOTE_REJECTED",
  "IO",
  "INTERNAL",
] as const;

export type AnsErrorCode = (typeof ANS_ERROR_CODES)[number];

const EXIT_CODES: Partial<Record<AnsErrorCode, number>> = {
  NOT_FOUND: 2,
  SIGNATURE_INVALID: 3,
  INVALID_SIGNATURE: 3,
  ASSERTION_INVALID: 3,
  EXPIRED: 3,
  AUDIENCE_MISMATCH: 3,
  KEY_MISMATCH: 3,
  PIN_MISMATCH: 3,
  REGISTRY_CORRUPT: 3,
  ALREADY_REGISTERED: 4,
  ALREADY_EXISTS: 4,
  ALREADY_INITIALIZED: 4,
};

export class AnsError extends Error {
  readonly code: AnsErrorCode;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(
    code: AnsErrorCode,
    message: string,
    options?: { hint?: string; exitCode?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AnsError";
    this.code = code;
    this.hint = options?.hint;
    this.exitCode = options?.exitCode ?? EXIT_CODES[code] ?? 1;
  }

  toJSON(): { code: AnsErrorCode; message: string; hint?: string } {
    const body: { code: AnsErrorCode; message: string; hint?: string } = {
      code: this.code,
      message: this.message,
    };
    if (this.hint !== undefined) {
      body.hint = this.hint;
    }
    return body;
  }
}

export function isAnsError(error: unknown): error is AnsError {
  return error instanceof AnsError;
}
