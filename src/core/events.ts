export interface SupportEvent {
  eventId: string;
  source: 'chatwoot' | 'telegram' | 'internal';
  type: 'message_created' | 'conversation_resolved' | 'conversation_opened';
  payload: any;
  rawEvent?: any;
}
