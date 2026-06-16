import { describe, expect, it } from 'vitest';
import { isRetryable } from './anthropic.js';

describe('isRetryable', () => {
  it('retries HTTP 5xx / 429 / 408 / 409', () => {
    for (const status of [408, 409, 429, 500, 502, 503, 529]) {
      expect(isRetryable({ status })).toBe(true);
    }
  });

  it('does NOT retry client errors (400/401/403/404)', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isRetryable({ status })).toBe(false);
    }
  });

  it('retries mid-stream error EVENTS that carry no status (the real failure we saw)', () => {
    // Shape surfaced by messages.stream() when the API sends an error event:
    const midStream = {
      message:
        '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"},"request_id":"req_x"}',
    };
    expect(isRetryable(midStream)).toBe(true);
  });

  it('retries by error.type for overloaded / rate-limit / api_error', () => {
    expect(isRetryable({ error: { type: 'overloaded_error' } })).toBe(true);
    expect(isRetryable({ error: { type: 'rate_limit_error' } })).toBe(true);
    expect(isRetryable({ error: { type: 'api_error' } })).toBe(true);
  });

  it('retries connection errors', () => {
    expect(isRetryable({ name: 'APIConnectionError' })).toBe(true);
    expect(isRetryable({ name: 'APIConnectionTimeoutError' })).toBe(true);
  });

  it('does NOT retry ordinary errors', () => {
    expect(isRetryable(new Error('something deterministic went wrong'))).toBe(false);
    expect(isRetryable({ error: { type: 'invalid_request_error' } })).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});
