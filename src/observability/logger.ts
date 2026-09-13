export interface LogContext {
  trace_id?: string;
  source?: string;
  source_event_ref?: string;
  conversation_id?: string;
  operation_id?: string;
  retry_count?: number;
  result?: string;
  error_category?: string;
  duration_ms?: number;
  eventId?: string;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export const logger = {
  info(msg: string, context?: LogContext) {
    console.log(JSON.stringify({ level: 'info', msg, ...context }));
  },
  error(msg: string, error: unknown, context?: LogContext) {
    console.error(JSON.stringify({ 
      level: 'error', 
      msg, 
      error: errorName(error),
      ...context 
    }));
  },
  warn(msg: string, context?: LogContext) {
    console.warn(JSON.stringify({ level: 'warn', msg, ...context }));
  }
};
