import { describe, expect, it } from 'vitest';
import {
  LEGACY_DLQ_QUEUE_NAME,
  LEGACY_MAIN_QUEUE_NAME,
  STAGING_DLQ_QUEUE_NAME,
  STAGING_MAIN_QUEUE_NAME,
  resolveQueueIdentities
} from '../src/config/queue-identities';

describe('Queue identity configuration', () => {
  it('preserves the frozen legacy pair only when both variables are absent', () => {
    expect(resolveQueueIdentities({})).toEqual({
      main: LEGACY_MAIN_QUEUE_NAME,
      dlq: LEGACY_DLQ_QUEUE_NAME
    });
  });

  it('accepts only the approved complete staging pair', () => {
    expect(resolveQueueIdentities({
      EXPECTED_MAIN_QUEUE_NAME: STAGING_MAIN_QUEUE_NAME,
      EXPECTED_DLQ_QUEUE_NAME: STAGING_DLQ_QUEUE_NAME
    })).toEqual({ main: STAGING_MAIN_QUEUE_NAME, dlq: STAGING_DLQ_QUEUE_NAME });
  });

  it.each([
    [{ EXPECTED_MAIN_QUEUE_NAME: STAGING_MAIN_QUEUE_NAME }],
    [{ EXPECTED_DLQ_QUEUE_NAME: STAGING_DLQ_QUEUE_NAME }],
    [{ EXPECTED_MAIN_QUEUE_NAME: '', EXPECTED_DLQ_QUEUE_NAME: STAGING_DLQ_QUEUE_NAME }],
    [{ EXPECTED_MAIN_QUEUE_NAME: STAGING_MAIN_QUEUE_NAME, EXPECTED_DLQ_QUEUE_NAME: '' }],
    [{ EXPECTED_MAIN_QUEUE_NAME: 'cz2128-staging-queue', EXPECTED_DLQ_QUEUE_NAME: STAGING_DLQ_QUEUE_NAME }],
    [{ EXPECTED_MAIN_QUEUE_NAME: STAGING_MAIN_QUEUE_NAME, EXPECTED_DLQ_QUEUE_NAME: 'cz2128-dlq' }],
    [{ EXPECTED_MAIN_QUEUE_NAME: STAGING_MAIN_QUEUE_NAME, EXPECTED_DLQ_QUEUE_NAME: STAGING_MAIN_QUEUE_NAME }],
    [{ EXPECTED_MAIN_QUEUE_NAME: LEGACY_MAIN_QUEUE_NAME, EXPECTED_DLQ_QUEUE_NAME: LEGACY_DLQ_QUEUE_NAME }]
  ])('rejects partial, empty, mismatched, equal or explicitly legacy variables: %j', config => {
    expect(() => resolveQueueIdentities(config)).toThrow('QUEUE_IDENTITY_CONFIG_INVALID');
  });
});
