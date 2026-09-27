import { Env } from '../config/env';
import { LearningCandidateRow } from './types';

export const NOTION_API_VERSION = '2026-03-11';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_TIMEOUT_MS = 10000;

export type NotionLearningConfig =
  | { state: 'DISABLED' }
  | { state: 'INVALID'; reason: string }
  | {
      state: 'READY';
      token: string;
      candidateDataSourceId: string;
      knowledgeSourcesDataSourceId: string;
    };

export class NotionLearningError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'NotionLearningError';
  }
}

function validDataSourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

export function getNotionLearningConfig(env: Env): NotionLearningConfig {
  const enabled = env.NOTION_LEARNING_ENABLED?.trim().toLowerCase() === 'true';
  if (!enabled) return { state: 'DISABLED' };
  const token = env.NOTION_API_TOKEN?.trim() || '';
  const candidateDataSourceId = env.NOTION_LEARNING_CANDIDATES_DATA_SOURCE_ID?.trim() || '';
  const knowledgeSourcesDataSourceId = env.NOTION_KNOWLEDGE_SOURCES_DATA_SOURCE_ID?.trim() || '';
  if (
    token.length < 8 ||
    token.length > 4096 ||
    !validDataSourceId(candidateDataSourceId) ||
    !validDataSourceId(knowledgeSourcesDataSourceId)
  ) {
    return { state: 'INVALID', reason: 'NOTION_CONFIG_INCOMPLETE' };
  }
  return { state: 'READY', token, candidateDataSourceId, knowledgeSourcesDataSourceId };
}

async function notionRequest(
  config: Extract<NotionLearningConfig, { state: 'READY' }>,
  path: string,
  init: RequestInit = {}
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
  try {
    const response = await fetch(NOTION_API_BASE + path, {
      ...init,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      },
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 429) throw new NotionLearningError('NOTION_RATE_LIMITED');
      if (response.status >= 500) throw new NotionLearningError('NOTION_PROVIDER_5XX');
      if (response.status === 404) throw new NotionLearningError('NOTION_NOT_FOUND');
      if (response.status === 401 || response.status === 403) throw new NotionLearningError('NOTION_AUTH_FAILED');
      throw new NotionLearningError('NOTION_PROVIDER_4XX');
    }
    try {
      return await response.json();
    } catch {
      throw new NotionLearningError('NOTION_INVALID_RESPONSE');
    }
  } catch (error) {
    if (error instanceof NotionLearningError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NotionLearningError('NOTION_TIMEOUT');
    }
    throw new NotionLearningError('NOTION_TRANSPORT_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

export async function retrieveNotionDataSource(
  config: Extract<NotionLearningConfig, { state: 'READY' }>,
  dataSourceId: string
): Promise<any> {
  return notionRequest(config, `/data_sources/${encodeURIComponent(dataSourceId)}`);
}

export async function queryCandidatePages(
  config: Extract<NotionLearningConfig, { state: 'READY' }>,
  candidateId: string
): Promise<any[]> {
  const payload = await notionRequest(
    config,
    `/data_sources/${encodeURIComponent(config.candidateDataSourceId)}/query`,
    {
      method: 'POST',
      body: JSON.stringify({
        page_size: 3,
        filter: {
          property: 'Candidate ID',
          rich_text: { equals: candidateId }
        }
      })
    }
  );
  if (!payload || !Array.isArray(payload.results)) throw new NotionLearningError('NOTION_INVALID_RESPONSE');
  return payload.results.slice(0, 3);
}

export async function retrieveNotionPage(
  config: Extract<NotionLearningConfig, { state: 'READY' }>,
  pageId: string
): Promise<any> {
  return notionRequest(config, `/pages/${encodeURIComponent(pageId)}`);
}

export async function createNotionCandidatePage(
  config: Extract<NotionLearningConfig, { state: 'READY' }>,
  properties: Record<string, unknown>
): Promise<any> {
  return notionRequest(config, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: {
        type: 'data_source_id',
        data_source_id: config.candidateDataSourceId
      },
      properties
    })
  });
}

export async function updateNotionPage(
  config: Extract<NotionLearningConfig, { state: 'READY' }>,
  pageId: string,
  properties: Record<string, unknown>
): Promise<any> {
  return notionRequest(config, `/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties })
  });
}

function textFragments(value: string | null | undefined): Array<{ type: 'text'; text: { content: string } }> {
  if (!value) return [];
  const chars = Array.from(value);
  const fragments: Array<{ type: 'text'; text: { content: string } }> = [];
  for (let offset = 0; offset < chars.length; offset += 1900) {
    fragments.push({ type: 'text', text: { content: chars.slice(offset, offset + 1900).join('') } });
  }
  return fragments.slice(0, 10);
}

function isoDate(seconds: number | null): { start: string } | null {
  return seconds == null ? null : { start: new Date(seconds * 1000).toISOString() };
}

function propertyType(schema: any, name: string): string | null {
  const property = schema?.properties?.[name];
  return property && typeof property.type === 'string' ? property.type : null;
}

function statusProperty(schema: any, name: string, value: string): Record<string, unknown> {
  return propertyType(schema, name) === 'status'
    ? { status: { name: value } }
    : { select: { name: value } };
}

export function validateCandidateDataSourceSchema(schema: any): void {
  const expected: Record<string, string[]> = {
    'Candidate': ['title'],
    'Candidate ID': ['rich_text'],
    'Captured At': ['date'],
    'D1 Knowledge ID': ['rich_text'],
    'D1 Knowledge Version': ['number'],
    'Proposed Answer': ['rich_text'],
    'Question': ['rich_text'],
    'Review Notes': ['rich_text'],
    'Reviewed At': ['date'],
    'Risk': ['select', 'status'],
    'Source Conversation Ref': ['rich_text'],
    'Source Message Ref': ['rich_text'],
    'Status': ['select', 'status'],
    'Why Candidate': ['rich_text']
  };
  for (const [name, allowed] of Object.entries(expected)) {
    const type = propertyType(schema, name);
    if (!type || !allowed.includes(type)) throw new NotionLearningError('NOTION_SCHEMA_INVALID');
  }
}

export function validateKnowledgeSourcesDataSourceSchema(schema: any): void {
  const expected: Record<string, string[]> = {
    'Name': ['title'],
    'Source Ref': ['rich_text'],
    'Source URL': ['url'],
    'Type': ['select', 'status'],
    'Topic': ['rich_text', 'select'],
    'Status': ['select', 'status'],
    'Sensitivity': ['select', 'status'],
    'Review Notes': ['rich_text'],
    'D1 Knowledge ID': ['rich_text'],
    'D1 Version': ['number'],
    'Last Reviewed': ['date']
  };
  for (const [name, allowed] of Object.entries(expected)) {
    const type = propertyType(schema, name);
    if (!type || !allowed.includes(type)) throw new NotionLearningError('NOTION_KNOWLEDGE_SOURCES_SCHEMA_INVALID');
  }
}

function candidateTitle(candidate: LearningCandidateRow): string {
  const value = candidate.extracted_title
    || candidate.extracted_question
    || candidate.sanitized_question
    || 'Learning candidate';
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 120).join('') || 'Learning candidate';
}

export function candidateNotionProperties(candidate: LearningCandidateRow, schema: any): Record<string, unknown> {
  const status = candidate.review_status === 'NEEDS_REVIEW'
    ? 'Needs Review'
    : candidate.review_status.charAt(0) + candidate.review_status.slice(1).toLowerCase();
  return {
    'Candidate': { title: textFragments(candidateTitle(candidate)) },
    'Candidate ID': { rich_text: textFragments(candidate.id) },
    'Captured At': { date: isoDate(candidate.created_at) },
    'D1 Knowledge ID': { rich_text: textFragments(candidate.published_knowledge_id) },
    'D1 Knowledge Version': { number: candidate.published_knowledge_version },
    'Proposed Answer': { rich_text: textFragments(candidate.extracted_answer || candidate.sanitized_answer) },
    'Question': { rich_text: textFragments(candidate.extracted_question || candidate.sanitized_question) },
    'Review Notes': { rich_text: textFragments(candidate.review_notes) },
    'Reviewed At': { date: isoDate(candidate.reviewed_at) },
    'Risk': statusProperty(schema, 'Risk', candidate.risk_level === 'LOW' ? 'Low' : candidate.risk_level === 'MEDIUM' ? 'Medium' : 'High'),
    'Source Conversation Ref': { rich_text: textFragments(candidate.source_conversation_id) },
    'Source Message Ref': { rich_text: textFragments(candidate.source_human_message_id) },
    'Status': statusProperty(schema, 'Status', status),
    'Why Candidate': { rich_text: textFragments(candidate.extraction_reason) }
  };
}

export function notionPlainText(property: any): string {
  const values = property?.title || property?.rich_text;
  if (!Array.isArray(values)) return '';
  return values.map((item: any) => {
    if (typeof item?.plain_text === 'string') return item.plain_text;
    if (typeof item?.text?.content === 'string') return item.text.content;
    return '';
  }).join('');
}

export function notionStatusName(property: any): string {
  if (typeof property?.status?.name === 'string') return property.status.name;
  if (typeof property?.select?.name === 'string') return property.select.name;
  return '';
}

