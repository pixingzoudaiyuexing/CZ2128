import { LearningRiskLevel } from './types';

export interface SanitizedLearningText {
  text: string;
  riskLevel: LearningRiskLevel;
  flags: string[];
}

const MAX_LEARNING_TEXT_CHARS = 12000;

function addFlag(flags: string[], code: string): void {
  if (!flags.includes(code)) flags.push(code);
}

function redact(
  value: string,
  pattern: RegExp,
  replacement: string,
  flags: string[],
  code: string
): string {
  const probe = new RegExp(pattern.source, pattern.flags);
  if (!probe.test(value)) return value;
  addFlag(flags, code);
  return value.replace(pattern, replacement);
}

export function sanitizeLearningText(input: string): SanitizedLearningText {
  let value = input.normalize('NFKC').replace(/\u0000/g, '').trim();
  const flags: string[] = [];

  value = redact(value, /\b\d{5,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]', flags, 'TELEGRAM_TOKEN');
  value = redact(
    value,
    /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi,
    'Authorization: Bearer [REDACTED]',
    flags,
    'AUTHORIZATION'
  );
  value = redact(value, /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer [REDACTED]', flags, 'BEARER_TOKEN');
  value = redact(
    value,
    /\b(api[_ -]?key|webhook[_ -]?secret|client[_ -]?secret|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*[^\s,;]{8,}/gi,
    '$1=[REDACTED]',
    flags,
    'CREDENTIAL'
  );
  value = redact(
    value,
    /\b[A-Z0-9]{16,}_[A-Za-z0-9_-]{16,}\b/g,
    '[REDACTED_CREDENTIAL]',
    flags,
    'CREDENTIAL'
  );
  value = redact(
    value,
    /https?:\/\/[^\s<>()]+\?(?:[^\s<>()#]*&)?(?:token|sig|signature|key|secret|capability|auth|expires|x-amz-signature)=[^\s<>()#]+/gi,
    '[REDACTED_TEMP_URL]',
    flags,
    'TEMPORARY_URL'
  );
  value = redact(value, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]', flags, 'EMAIL');
  value = redact(value, /(?<!\d)\+?\d(?:[\s().-]*\d){7,14}(?!\d)/g, '[REDACTED_PHONE]', flags, 'PHONE');
  value = redact(
    value,
    /\b(name|full name|customer name|姓名|名字)\s*[:：]\s*[\p{L}\p{Script=Han}][\p{L}\p{Script=Han} .'-]{1,80}/giu,
    '$1: [REDACTED_NAME]',
    flags,
    'PERSON_NAME'
  );
  value = redact(
    value,
    /\b(account|customer|order|reference|ref|invoice|ticket|账号|客户|订单|单号|参考号)\s*(?:id|number|no\.?|编号|号)?\s*[:：#]?\s*[A-Z0-9][A-Z0-9_-]{4,}/giu,
    '$1 [REDACTED_ID]',
    flags,
    'CUSTOMER_REFERENCE'
  );

  if (Array.from(value).length > MAX_LEARNING_TEXT_CHARS) {
    value = Array.from(value).slice(0, MAX_LEARNING_TEXT_CHARS).join('');
    addFlag(flags, 'TRUNCATED');
  }

  const highRisk = flags.some(code => [
    'TELEGRAM_TOKEN',
    'AUTHORIZATION',
    'BEARER_TOKEN',
    'CREDENTIAL',
    'TEMPORARY_URL'
  ].includes(code));
  const mediumRisk = flags.length > 0;
  return {
    text: value,
    riskLevel: highRisk ? 'HIGH' : mediumRisk ? 'MEDIUM' : 'LOW',
    flags
  };
}

export function mergeLearningRisk(
  ...items: Array<Pick<SanitizedLearningText, 'riskLevel' | 'flags'>>
): { riskLevel: LearningRiskLevel; flags: string[] } {
  const flags = Array.from(new Set(items.flatMap(item => item.flags))).sort();
  const levels = items.map(item => item.riskLevel);
  return {
    riskLevel: levels.includes('HIGH') ? 'HIGH' : levels.includes('MEDIUM') ? 'MEDIUM' : 'LOW',
    flags
  };
}
