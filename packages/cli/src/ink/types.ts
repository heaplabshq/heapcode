import type { ChatMessage } from '@heapcode/core';

export type TranscriptItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool'; id: string; name: string; description: string; status: 'running' | 'ok' | 'error'; summary?: string; checkpoint?: string }
  | { kind: 'plan'; text: string }
  | { kind: 'system'; text: string };
