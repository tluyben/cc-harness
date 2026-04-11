/**
 * errors.ts
 *
 * Error classification, retry back-off, and credential-rotation logic for the
 * Claude API errors documented at:
 * https://platform.claude.com/docs/en/api/errors
 *
 * Error taxonomy
 * ─────────────────────────────────────────────────────────────────────────────
 * RETRY_FOREVER  – 529 overloaded_error
 *                  The API is temporarily busy.  Will always clear eventually.
 *                  Retry indefinitely with exponential back-off.
 *
 * RETRY_LIMITED  – 500 api_error        (unexpected internal error, transient)
 *                  504 timeout_error    (request timed out)
 *                  429 rate_limit_error (account rate-limited, resets soon)
 *                  Retry up to MAX_LIMITED_RETRIES times with back-off.
 *
 * ROTATE_CREDS   – 401 authentication_error  (bad / expired key)
 *                  402 billing_error         (quota / billing exhausted)
 *                  Rotate to the next credentials_N.json file and retry.
 *                  Give up once all credentials have been tried.
 *
 * FATAL          – 400 invalid_request_error  (bad input – won't change)
 *                  403 permission_error       (no access – won't change)
 *                  404 not_found_error        (resource gone)
 *                  413 request_too_large      (input too big)
 *                  Fail immediately; retrying would produce the same error.
 */

export type ErrorClass = "forever" | "limited" | "rotate" | "fatal";

const RETRY_FOREVER = new Set(["overloaded_error"]);
const RETRY_LIMITED = new Set(["api_error", "timeout_error", "rate_limit_error"]);
const ROTATE_CREDS = new Set(["authentication_error", "billing_error"]);

export function classifyError(errorType: string): ErrorClass {
  if (RETRY_FOREVER.has(errorType)) return "forever";
  if (RETRY_LIMITED.has(errorType)) return "limited";
  if (ROTATE_CREDS.has(errorType)) return "rotate";
  return "fatal";
}

/** Maximum attempts for RETRY_LIMITED errors (first attempt counts as 0). */
export const MAX_LIMITED_RETRIES = 8;

/**
 * Exponential back-off with full jitter.
 * delay = random(0, min(maxMs, baseMs * 2^attempt))
 */
export function backoffMs(
  attempt: number,
  baseMs = 1_000,
  maxMs = 60_000,
): number {
  const cap = Math.min(maxMs, baseMs * Math.pow(2, Math.min(attempt, 12)));
  return Math.floor(Math.random() * cap);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Credential rotation ──────────────────────────────────────────────────────
//
// Layout expected in $HOME/.claude/:
//   .credentials.json      ← the ACTIVE credential file (symlink or copy)
//   credentials_1.json     ← credential slot 1
//   credentials_2.json     ← credential slot 2
//   ...
//
// When we hit an auth/billing error we:
//   1. Find which slot the current .credentials.json matches (current index).
//   2. Remember that as the "start" index so we know when we've gone full circle.
//   3. Advance to the next slot (wrapping 1→2→…→N→1).
//   4. Copy that file to .credentials.json and retry.
//   5. If we arrive back at the start index, all slots are exhausted → give up.

const CLAUDE_DIR = `${Deno.env.get("HOME") ?? ""}/.claude`;

/** Read a file as a trimmed string; returns null if not readable. */
async function readMaybe(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    return null;
  }
}

/**
 * Return the index N such that credentials_N.json matches .credentials.json,
 * or null if no match is found.
 */
export async function findCurrentCredentialIndex(): Promise<number | null> {
  const active = await readMaybe(`${CLAUDE_DIR}/.credentials.json`);
  if (!active) return null;

  for (let i = 1; ; i++) {
    const candidate = await readMaybe(`${CLAUDE_DIR}/credentials_${i}.json`);
    if (candidate === null) break; // no more files
    if (candidate === active) return i;
  }
  return null;
}

/** Count how many credentials_N.json files exist (contiguous from 1). */
export async function countCredentials(): Promise<number> {
  let n = 0;
  for (let i = 1; ; i++) {
    try {
      await Deno.stat(`${CLAUDE_DIR}/credentials_${i}.json`);
      n = i;
    } catch {
      break;
    }
  }
  return n;
}

/** Overwrite .credentials.json with the content of credentials_N.json. */
export async function activateCredential(index: number): Promise<void> {
  const src = await Deno.readTextFile(
    `${CLAUDE_DIR}/credentials_${index}.json`,
  );
  await Deno.writeTextFile(`${CLAUDE_DIR}/.credentials.json`, src);
}

/**
 * Stateful credential rotator.  One instance per `executeClause` invocation.
 *
 * Usage:
 *   const rot = new CredentialRotator();
 *   const advanced = await rot.advance();  // returns false when exhausted
 */
export class CredentialRotator {
  private total = 0;
  private startIdx: number | null = null;
  private currentIdx: number | null = null;
  private initialised = false;

  private async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;
    this.total = await countCredentials();
    if (this.total > 0) {
      this.startIdx = (await findCurrentCredentialIndex()) ?? 1;
      this.currentIdx = this.startIdx;
    }
  }

  /** Try to move to the next credential.
   *  Returns true  → rotated; caller should retry.
   *  Returns false → no credentials available OR all exhausted → give up.
   */
  async advance(): Promise<boolean> {
    await this.init();
    if (this.total === 0) return false;

    const next = (this.currentIdx! % this.total) + 1; // wrap N→1

    if (next === this.startIdx) {
      // We've looped back to where we started — all credentials failed.
      return false;
    }

    await activateCredential(next);
    this.currentIdx = next;
    console.error(
      `[cc-harnass] credential rotated → credentials_${next}.json`,
    );
    return true;
  }

  /** Call when a request succeeds after rotation — resets internal state. */
  reset(): void {
    this.initialised = false;
    this.startIdx = null;
    this.currentIdx = null;
  }
}
