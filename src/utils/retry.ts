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

  // HTTP status codes
  if (error.statusCode) {
    // 429 Rate Limiting
    if (error.statusCode === 429) {
      return true;
    }
    // 5xx Server Errors
    if (error.statusCode >= 500 && error.statusCode < 600) {
      return true;
    }
  }

  return false;
}

/**
 * Calculates the delay for the next retry attempt using exponential backoff.
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, options: Required<RetryOptions>): number {
  const exponentialDelay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
  let delay = Math.min(exponentialDelay, options.maxDelayMs);

  // Add jitter to prevent thundering herd problem
  if (options.jitter) {
    // Random jitter between 0 and delay
    delay = Math.random() * delay;
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
          statusCode: lastError.statusCode,
          code: lastError.code
        }, `Non-retryable error for ${opts.operationName}, failing immediately`);
        throw lastError;
      }

      // Calculate delay and wait before retry
      const delay = calculateDelay(attempt, opts);
      logger.warn({
        operation: opts.operationName,
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: delay,
        err: lastError.message,
        statusCode: lastError.statusCode,
        code: lastError.code
      }, `⚠️  ${opts.operationName} failed, retrying...`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript requires it
  throw lastError || new Error('Unexpected retry loop exit');
}
