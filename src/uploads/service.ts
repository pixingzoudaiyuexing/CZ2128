import { createCrispMessage, fetchCrispConversationState } from '../adapters/crisp/api';
import { sendTelegramMessage } from '../adapters/telegram/api';
import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { trustedPublicOrigin } from '../config/public-origin';
import { ensureAttachmentGrant } from '../attachments/grants';
import { AttachmentRow } from '../core/attachments';
import { getUploadConfig } from '../config/uploads';
import { executeOutboundOperation } from '../core/outbound-operations';
import { ProviderDeliveryError } from '../core/errors';
import { buildCrispTargetEvidence, buildTelegramTargetEvidence } from '../core/outbound-evidence';
import {
  deriveUploadInviteToken,
  hashUploadCapability,
  stableUploadInviteId
} from './capability';
import {
  createOrGetUploadInvite,
  revokeActiveUploadInvite,
  revokeUploadInviteById,
  UploadInviteRow
} from './repository';

export interface UploadInviteConversation {
  id: string;
  helpdesk_provider: string;
  helpdesk_account_ref: string | null;
  helpdesk_conversation_ref: string | null;
  operator_thread_ref: string | null;
  operator_thread_status: string | null;
}

export interface UploadInviteCommand {
  supportProfileVersion: number;
  updateRef: string;
  operatorRef: string;
  publicOrigin: string;
  threadRef: string;
  uploadRole?: 'CUSTOMER' | 'OPERATOR';
  offset?: number;
}

export function canonicalUploadOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) throw new Error('UPLOAD_PUBLIC_ORIGIN_INVALID');
  return url.origin;
}

function requireCapabilitySecret(env: Env): string {
  const secret = env.UPLOAD_CAPABILITY_SECRET || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('UPLOAD_CAPABILITY_SECRET_INVALID');
  return secret;
}

function inviteMessage(url: string, maxFiles: number, maxTotalBytes: number): string {
  return [
    'Temporary file upload / 临时文件上传',
    '',
    '客服已为当前会话开启临时文件上传入口。',
    '链接仅用于当前会话，15 分钟内有效。',
    '支持图片和普通文件，可连续上传。大文件支持分片和断点续传。',
    '普通文件保存 72 小时，图片保存 7 天，从成功存储开始计算。',
    '',
    url
  ].join('\n');
}

async function sendTelegramAck(
  env: Env,
  conversationId: string,
  threadRef: string,
  operationId: string,
  subjectRef: string,
  text: string
): Promise<void> {
  await executeOutboundOperation(
    env,
    conversationId,
    'telegram',
    'SEND_MESSAGE',
    async (_opId, lifecycle) => {
      const response = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, text, lifecycle);
      return { providerMessageRef: response.messageId };
    },
    operationId,
    {
      subject: { type: 'CONTROL_ACK', ref: subjectRef },
      targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, threadRef, 'sendMessage')
    }
  );
}

export async function createAndSendUploadInvite(
  env: Env,
  conversation: UploadInviteConversation,
  command: UploadInviteCommand
): Promise<'SENT' | 'AMBIGUOUS' | 'FAILED_FINAL' | 'STALE'> {
  if (
    conversation.helpdesk_provider !== 'crisp' ||
    !conversation.helpdesk_account_ref ||
    !conversation.helpdesk_conversation_ref ||
    !conversation.operator_thread_ref ||
    conversation.operator_thread_ref !== command.threadRef ||
    conversation.operator_thread_status !== 'OPEN'
  ) throw new Error('UPLOAD_INVITE_CONVERSATION_INVALID');

  const initialState = await fetchCrispConversationState(
    env,
    conversation.helpdesk_account_ref,
    conversation.helpdesk_conversation_ref
  );
  if (initialState === 'resolved') {
    await sendTelegramAck(
      env,
      conversation.id,
      command.threadRef,
      'upload_invite_resolved_ack:' + command.supportProfileVersion + ':' + command.updateRef,
      'upload-invite-resolved:' + command.supportProfileVersion + ':' + command.updateRef,
      '当前 Crisp 会话已关闭，未创建临时上传入口。'
    );
    return 'FAILED_FINAL';
  }

  const secret = requireCapabilitySecret(env);
  const origin = trustedPublicOrigin(env);
  const attachments = getAttachmentConfig(env);
  const config = getUploadConfig(attachments);
  const inviteId = await stableUploadInviteId(
    conversation.id,
    command.supportProfileVersion,
    command.updateRef
  );
  const token = await deriveUploadInviteToken(secret, inviteId);
  const tokenHash = await hashUploadCapability(token);
  const now = Math.floor(Date.now() / 1000);
  const created = await createOrGetUploadInvite(env, {
    id: inviteId,
    tokenHash,
    conversationId: conversation.id,
    crispWebsiteRef: conversation.helpdesk_account_ref,
    crispSessionRef: conversation.helpdesk_conversation_ref,
    telegramGroupRef: env.BOT_GROUP_ID,
    telegramThreadRef: command.threadRef,
    supportProfileVersion: command.supportProfileVersion,
    operatorRef: command.operatorRef,
    updateRef: command.updateRef,
    expiresAt: now + config.inviteTtlSeconds,
    maxFiles: config.maxFiles,
    maxTotalBytes: Math.min(config.maxTotalBytes, 20 * 1024 * 1024),
    uploadRole: command.uploadRole
  });

  if (created.outcome === 'STALE') return 'STALE';
  const invite: UploadInviteRow = created.row;
  const uploadUrl = origin + '/uploads/' + token;
  if (invite.upload_role === 'OPERATOR') {
    await sendTelegramAck(env, conversation.id, command.threadRef,
      'operator_upload_portal:' + invite.id, 'operator-upload:' + invite.id,
      'Telegram 云端 Bot 接口无法下载超过 20 MB 的文件。请在此安全入口上传原文件，成功后再转发给当前 Crisp 客户：\n' + uploadUrl);
    return 'SENT';
  }
  const operationId = 'upload_invite_crisp:' + invite.id;
  const result = await executeOutboundOperation(
    env,
    conversation.id,
    'crisp',
    'SEND_MESSAGE',
    async (opId, lifecycle) => {
      let latestState: 'pending' | 'unresolved' | 'resolved';
      try {
        latestState = await fetchCrispConversationState(
          env,
          conversation.helpdesk_account_ref!,
          conversation.helpdesk_conversation_ref!
        );
      } catch {
        throw new ProviderDeliveryError(
          'FINAL',
          'CRISP_STATE_UNCONFIRMED_BEFORE_UPLOAD_INVITE_SEND',
          { provider: 'CRISP' }
        );
      }
      if (latestState === 'resolved') {
        throw new ProviderDeliveryError('FINAL', 'CRISP_CONVERSATION_RESOLVED', { provider: 'CRISP' });
      }
      const response = await createCrispMessage(
        env,
        conversation.helpdesk_account_ref!,
        conversation.helpdesk_conversation_ref!,
        inviteMessage(uploadUrl, invite.max_files, invite.max_total_bytes),
        opId,
        lifecycle
      );
      return { providerMessageRef: response.messageId };
    },
    operationId,
    {
      subject: { type: 'UPLOAD_INVITE', ref: invite.id },
      targetEvidence: buildCrispTargetEvidence(
        conversation.helpdesk_account_ref,
        conversation.helpdesk_conversation_ref
      )
    }
  );

  if (result.status === 'FAILED_FINAL') {
    await revokeUploadInviteById(env, invite.id);
  }
  const ack = result.status === 'SENT'
    ? '临时上传入口已发送给当前 Crisp 客户；15 分钟后自动失效。'
    : result.status === 'AMBIGUOUS'
      ? '临时上传入口发送结果不确定；不会自动重发。现有入口仍会按 TTL 自动失效。'
      : '临时上传入口未成功发送，入口已撤销；不会自动重放可见消息。';

  await sendTelegramAck(
    env,
    conversation.id,
    command.threadRef,
    'upload_invite_ack:' + invite.id,
    'upload-invite:' + invite.id,
    ack
  );

  if (result.status === 'SENT') return 'SENT';
  if (result.status === 'AMBIGUOUS') return 'AMBIGUOUS';
  return 'FAILED_FINAL';
}

export async function revokeUploadInviteFromTelegram(
  env: Env,
  conversation: UploadInviteConversation,
  command: UploadInviteCommand
): Promise<void> {
  if (!conversation.operator_thread_ref || conversation.operator_thread_ref !== command.threadRef) {
    throw new Error('UPLOAD_INVITE_CONVERSATION_INVALID');
  }
  const revoked = await revokeActiveUploadInvite(env, conversation.id);
  await sendTelegramAck(
    env,
    conversation.id,
    command.threadRef,
    'upload_revoke_ack:' + command.supportProfileVersion + ':' + command.updateRef,
    'upload-revoke:' + command.supportProfileVersion + ':' + command.updateRef,
    revoked > 0 ? '当前临时上传入口已撤销。' : '当前没有可撤销的临时上传入口。'
  );
}

export async function sendConversationFiles(env: Env, conversation: UploadInviteConversation, command: UploadInviteCommand): Promise<void> {
  const offset=Number(command.offset || 0);
  const files = await env.DB.prepare(`SELECT * FROM attachments WHERE conversation_id=? AND stored_at IS NOT NULL
    AND deleted_at IS NULL AND retention_expires_at>? ORDER BY stored_at DESC,id LIMIT 31 OFFSET ?`)
    .bind(conversation.id,Math.floor(Date.now()/1000),offset).all<AttachmentRow>();
  const more=files.results.length>30;files.results=files.results.slice(0,30);
  const lines = await Promise.all(files.results.map(async file => {
    const grant = await ensureAttachmentGrant(env,file,true);
    return `${file.safe_filename}\n${grant.url}\n保存至 ${new Date(grant.expiresAt*1000).toISOString()}`;
  }));
  if(more)lines.push(`查看更多文件：在本 Topic 发送 /files ${offset+30}`);
  const batches:string[]=[];let current='';
  for(const line of lines){if(current.length+line.length+2>3500){batches.push(current);current='';}current+=(current?'\n\n':'')+line;}
  if(current)batches.push(current);if(!batches.length)batches.push('当前会话没有仍在保存期限内的文件。');
  for(let index=0;index<batches.length;index++)await sendTelegramAck(env,conversation.id,command.threadRef,
    `files_ack:${command.supportProfileVersion}:${command.updateRef}:${index}`,`files:${command.updateRef}:${index}`,batches[index]);
}
