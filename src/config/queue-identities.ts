export const LEGACY_MAIN_QUEUE_NAME = 'cz2128-queue';
export const LEGACY_DLQ_QUEUE_NAME = 'cz2128-dlq';
export const STAGING_MAIN_QUEUE_NAME = 'cz2128-4c-staging-queue';
export const STAGING_DLQ_QUEUE_NAME = 'cz2128-4c-staging-dlq';

export interface QueueIdentityConfig {
  EXPECTED_MAIN_QUEUE_NAME?: string;
  EXPECTED_DLQ_QUEUE_NAME?: string;
}

export interface QueueIdentities {
  main: string;
  dlq: string;
}

export function resolveQueueIdentities(env: QueueIdentityConfig): QueueIdentities {
  const main = env.EXPECTED_MAIN_QUEUE_NAME;
  const dlq = env.EXPECTED_DLQ_QUEUE_NAME;

  if (main === undefined && dlq === undefined) {
    return { main: LEGACY_MAIN_QUEUE_NAME, dlq: LEGACY_DLQ_QUEUE_NAME };
  }
  if (main === STAGING_MAIN_QUEUE_NAME && dlq === STAGING_DLQ_QUEUE_NAME) {
    return { main, dlq };
  }
  throw new Error('QUEUE_IDENTITY_CONFIG_INVALID');
}
