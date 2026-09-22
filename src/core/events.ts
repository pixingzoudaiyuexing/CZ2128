import { AttachmentDescriptor } from './attachments';

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
    content?: string;
    actorRole: 'CUSTOMER' | 'OPERATOR';
    attachments?: AttachmentDescriptor[];
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

export interface CrispMessageEvent extends QueueEventBase {
  source: 'crisp';
  type: 'message_created';
  payload: {
    websiteRef: string;
    sessionRef: string;
    customerRef: string;
    customerName?: string;
    messageRef: string;
    actorRole: 'CUSTOMER' | 'OPERATOR';
    content?: string;
    selection?: {
      pickerId: string;
      pickerMessageRef: string;
      value: string;
      label: string;
    };
  };
}

export interface TelegramMessageEvent extends QueueEventBase {
  source: 'telegram';
  type: 'message_created';
  payload: {
    supportProfileVersion: number;
    updateRef: string;
    messageRef: string;
    threadRef: string;
    content?: string;
    attachments?: AttachmentDescriptor[];
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

export interface AttachmentTransferEvent extends QueueEventBase {
  source: 'internal';
  type: 'attachment_transfer';
  payload: {
    attachmentId: string;
    accessToken: string;
    locator: AttachmentDescriptor['locator'];
  };
}

export type ChatwootEvent = ChatwootMessageEvent | ChatwootLifecycleEvent;
export type SupportEvent = ChatwootEvent | CrispMessageEvent | TelegramMessageEvent | AiTriggerEvent | AttachmentTransferEvent;
