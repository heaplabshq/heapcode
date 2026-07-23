import type { ChatMessage } from '@heapcode/core';

export type TranscriptItem =
  | { kind: 'header'; version?: string; profileName: string; model: string; baseUrl?: string; cwd?: string; messageCount?: number; canResume?: boolean }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool'; id: string; name: string; description: string; status: 'running' | 'ok' | 'error'; summary?: string; checkpoint?: string }
  | { kind: 'plan'; text: string }
  | { kind: 'system'; text: string };
