interface QueueEventBase {
  version: 1;
  eventId: string;
}

export interface ChatwootMessageEvent extends QueueEventBase {
  source: 'chatwoot';
  type: 'message_created';
  payload: {
    accountRef: string;
    conversationRef: string;
    customerRef: string;
    customerName?: string;
    messageRef: string;
    content: string;
    actorRole: 'CUSTOMER' | 'OPERATOR';
  };
}

export interface ChatwootLifecycleEvent extends QueueEventBase {
  source: 'chatwoot';
  type: 'conversation_status_changed';
  payload: {
    accountRef: string;
    conversationRef: string;
    status: 'open' | 'resolved';
  };
}

export interface TelegramMessageEvent extends QueueEventBase {
  source: 'telegram';
  type: 'message_created';
  payload: {
    updateRef: string;
    messageRef: string;
    threadRef: string;
    content: string;
  };
}

export interface AiTriggerEvent extends QueueEventBase {
  source: 'internal';
  type: 'ai_trigger';
  payload: {
    convId: string;
    messageId: string;
  };
}

export type ChatwootEvent = ChatwootMessageEvent | ChatwootLifecycleEvent;
export type SupportEvent = ChatwootEvent | TelegramMessageEvent | AiTriggerEvent;
