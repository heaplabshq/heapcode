import type { ChatMessage } from '@heapcode/core';

export type TranscriptItem =
  | { kind: 'header'; version?: string; profileName: string; model: string; baseUrl?: string; cwd?: string; messageCount?: number; canResume?: boolean }
  | { kind: 'message'; message: ChatMessage }
  | {
      kind: 'tool';
      id: string;
      name: string;
      description: string;
      status: 'running' | 'ok' | 'error';
      summary?: string;
      /** Called by a delegate_task sub-agent — rendered indented, under its parent's tool chip. */
      indent?: boolean;
    }
  | { kind: 'plan'; text: string }
  | { kind: 'system'; text: string };
