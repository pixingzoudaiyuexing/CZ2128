export interface SupportEvent {
  source: 'chatwoot' | 'telegram';
  type: 'message_created' | 'conversation_status_changed';
  eventId: string;
  payload: any;
}
