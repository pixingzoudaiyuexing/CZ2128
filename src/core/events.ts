export interface SupportEvent {
  source: 'chatwoot' | 'telegram' | 'internal';
  type: 'message_created' | 'conversation_status_changed' | 'ai_trigger';
  eventId: string;
  payload: any;
}

export class RetryLaterError extends Error {
  constructor(message: string, public delaySeconds: number) {
    super(message);
    this.name = 'RetryLaterError';
  }
}
