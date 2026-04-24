/** Body of a POST /prompt request */
export interface PromptRequest {
  /** The prompt to send to Claude */
  prompt: string;
  /** Absolute path to the working directory for this conversation */
  dir: string;
  /**
   * If true, continues the most recent conversation in `dir` (passes --continue / -c).
   * Defaults to false.
   */
  continue?: boolean;
  /**
   * Run Claude as this OS username. Required when the server is running as root
   * (Claude must never run as root). Optional otherwise — omit to run as the
   * current process user.
   */
  asUser?: string;
  /** Optional system prompt passed to Claude via --system-prompt. */
  systemPrompt?: string;
}

/** A parsed Claude stream-json event line */
export interface ClaudeEvent {
  type: string;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}
