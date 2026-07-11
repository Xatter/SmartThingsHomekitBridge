import { logger } from './logger';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Whether to add jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Optional operation name for logging */
  operationName?: string;
}

export interface RetryableError extends Error {
  statusCode?: number;
  code?: string;
  /**
   * Axios-shaped error response, as thrown by @smartthings/core-sdk (v8+).
   * The SDK is axios-based and does NOT set `statusCode` on thrown errors -
   * the HTTP status lives at `error.response.status` instead.
   */
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
  };
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitter: true,
  operationName: 'operation',
};

/**
 * Reads the HTTP status code off an error, whichever shape it came in as.
 * Some callers set `error.statusCode` directly; the SmartThings SDK (axios-based)
 * instead throws errors shaped like `{ response: { status } }`.
 */
function getStatusCode(error: RetryableError): number | undefined {
  return error.statusCode ?? error.response?.status;
}

/**
 * Determines if an error is transient and should be retried.
 * Retries on:
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 * - HTTP 5xx server errors
 * - HTTP 429 rate limiting
 * - HTTP 503 service unavailable
 */
function isRetryableError(error: RetryableError): boolean {
  // Network errors
  if (error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED') {
    return true;
  }

  // HTTP status codes (checks both error.statusCode and axios-shaped error.response.status)
  const statusCode = getStatusCode(error);
  if (statusCode) {
    // 429 Rate Limiting
    if (statusCode === 429) {
      return true;
    }
    // 5xx Server Errors
    if (statusCode >= 500 && statusCode < 600) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts a Retry-After delay (in ms) from a 429 error's response headers, if present.
 * Only the integer-seconds form of Retry-After is supported (which is what SmartThings sends).
 * @param error - The error to inspect
 * @param maxDelayMs - Upper bound to cap the resulting delay at
 * @returns Delay in milliseconds, or undefined if no usable Retry-After header is present
 */
function getRetryAfterMs(error: RetryableError, maxDelayMs: number): number | undefined {
  if (getStatusCode(error) !== 429) {
    return undefined;
  }

  const headerValue = error.response?.headers?.['retry-after'];
  if (headerValue === undefined || headerValue === null) {
    return undefined;
  }

  const rawValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return Math.min(seconds * 1000, maxDelayMs);
}

/**
 * Calculates the delay for the next retry attempt.
 * For 429 responses that carry a Retry-After header, that value is used directly
 * (capped at maxDelayMs). Otherwise falls back to exponential backoff.
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Retry options
 * @param error - The error that triggered this retry, used to honor Retry-After
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, options: Required<RetryOptions>, error?: RetryableError): number {
  if (error) {
    const retryAfterMs = getRetryAfterMs(error, options.maxDelayMs);
    if (retryAfterMs !== undefined) {
      return retryAfterMs;
    }
  }

  const exponentialDelay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
  let delay = Math.min(exponentialDelay, options.maxDelayMs);

  // Add jitter to prevent thundering herd problem
  if (options.jitter) {
    // Additive jitter: add up to 10% of the delay
    // This ensures meaningful backoff while preventing thundering herd
    delay = delay + Math.random() * (delay * 0.1);
  }

  return Math.floor(delay);
}

/**
 * Executes an async function with exponential backoff retry logic.
 * Only retries on transient errors (network issues, 5xx, rate limits).
 *
 * @param fn - Async function to execute with retry
 * @param options - Retry configuration options
 * @returns Promise that resolves with the function result or rejects after all retries exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   async () => await client.devices.list(),
 *   { maxRetries: 3, operationName: 'list devices' }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: RetryableError | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Try the operation
      return await fn();
    } catch (error) {
      lastError = error as RetryableError;

      // If this is the last attempt, throw the error
      if (attempt === opts.maxRetries) {
        logger.error({
          operation: opts.operationName,
          attempt: attempt + 1,
          maxRetries: opts.maxRetries,
          err: lastError
        }, `❌ ${opts.operationName} failed after all retries`);
        throw lastError;
      }

      // Check if error is retryable
      if (!isRetryableError(lastError)) {
        logger.debug({
          operation: opts.operationName,
          err: lastError,
          statusCode: getStatusCode(lastError),
          code: lastError.code
        }, `Non-retryable error for ${opts.operationName}, failing immediately`);
        throw lastError;
      }

      // Calculate delay and wait before retry (honors Retry-After on 429s)
      const delay = calculateDelay(attempt, opts, lastError);
      logger.warn({
        operation: opts.operationName,
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: delay,
        err: lastError.message,
        statusCode: getStatusCode(lastError),
        code: lastError.code
      }, `⚠️  ${opts.operationName} failed, retrying...`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // This should never be reached due to the throw in the loop above,
  // but TypeScript's control flow analysis requires a return/throw here
  const errorMessage = lastError ? lastError.message : 'none';
  logger.error({
    operation: opts.operationName,
    maxRetries: opts.maxRetries,
    lastError: lastError,
  }, `❗ Unexpected exit from retry loop for ${opts.operationName}. This indicates a bug. Please report with details.`);

  throw lastError || new Error(
    `Unexpected exit from retry loop for ${opts.operationName}. No result was returned and no error was thrown. ` +
    `Last error: ${errorMessage}. This is a bug in the retry logic.`
  );
}
