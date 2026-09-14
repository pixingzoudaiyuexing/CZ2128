export interface AdminBootstrap {
  token: string;
  path: string;
  webhookSecret: string;
  userIds: ReadonlySet<string>;
}

export interface AdminContext {
  updateId: string;
  userId: string;
  chatId: string;
  messageId?: number;
  text?: string;
  callbackId?: string;
  callbackData?: string;
}

export type AdminKeyboard = Array<Array<{ text: string; callback_data: string }>>;
