import { SafeErrorCode } from '../core/error-taxonomy';
import { safeErrorMetadata } from '../core/errors';

export interface LogContext {
  trace_id?: string;
  source?: string;
  source_event_ref?: string;
  conversation_id?: string;
  operation_id?: string;
  generation_id?: string;
  retry_count?: number;
  result?: string;
  error_category?: string;
  duration_ms?: number;
  eventId?: string;
  attachment_id?: string;
  destination_provider?: string;
  size_bytes?: number;
  mime_type?: string;
  error_code?: SafeErrorCode;
  provider?: string;
  stage?: string;
  http_status?: number;
  retry_after_seconds?: number;
  retry_exhausted?: boolean;
}

export const logger = {
  info(msg: string, context?: LogContext) {
    console.log(JSON.stringify({ level: 'info', msg, ...context }));
  },
  error(msg: string, error: unknown, context?: LogContext) {
    console.error(JSON.stringify({
      level: 'error',
      msg,
      ...safeErrorMetadata(error),
      ...context
    }));
  },
  warn(msg: string, context?: LogContext) {
    console.warn(JSON.stringify({ level: 'warn', msg, ...context }));
  }
};
