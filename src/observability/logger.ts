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

export const logger = {
  info(msg: string, context?: LogContext) {
    console.log(JSON.stringify({ level: 'info', msg, ...context }));
  },
  error(msg: string, error: any, context?: LogContext) {
    console.error(JSON.stringify({ 
      level: 'error', 
      msg, 
      error: String(error), 
      ...context 
    }));
  },
  warn(msg: string, context?: LogContext) {
    console.warn(JSON.stringify({ level: 'warn', msg, ...context }));
  }
};
