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
    automated?: boolean;
    operationMarker?: string;
    attachments?: AttachmentDescriptor[];
    selection?: {
      pickerId: string;
      pickerMessageRef: string;
      value: string;
      label: string;
    };
  };
}

export interface CrispLifecycleEvent extends QueueEventBase {
  source: 'crisp';
  type: 'conversation_state_changed';
  payload: {
    websiteRef: string;
    sessionRef: string;
    state: 'pending' | 'unresolved' | 'resolved';
    providerTimestamp: number;
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
    operatorRef?: string;
    content?: string;
    attachments?: AttachmentDescriptor[];
    publicOrigin?: string;
  };
}

export interface TelegramControlEvent extends QueueEventBase {
  source: 'telegram';
  type: 'control_action';
  payload: {
    supportProfileVersion: number;
    updateRef: string;
    callbackQueryRef: string;
    messageRef: string;
    threadRef: string;
    operatorRef: string;
    action: 'AI_ON' | 'AI_OFF';
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
    publicOrigin?: string;
  };
}

export type ChatwootEvent = ChatwootMessageEvent | ChatwootLifecycleEvent;
export type CrispEvent = CrispMessageEvent | CrispLifecycleEvent;
export type TelegramEvent = TelegramMessageEvent | TelegramControlEvent;
export type SupportEvent = ChatwootEvent | CrispEvent | TelegramEvent | AiTriggerEvent | AttachmentTransferEvent;
