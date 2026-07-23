import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import {
  runAgent,
  type Conversation,
  type PermissionChoice,
  type Provider,
  type ProviderProfileConfig,
  type StoredMessage,
  type ToolDefinition,
} from '@heapcode/core';
import type { JsonConversationStore } from '../history/store.js';
import type { WorkspaceToolExecutor } from '../agent/workspaceTools.js';
import type { SessionCheckpoint } from '../agent/checkpoint.js';
import type { PermissionEngine } from '../agent/permissions.js';
import type { ShadowGit } from '../agent/shadowGit.js';
import { Composer } from './Composer.js';
import { MessageView } from './MessageView.js';
import { PermissionPrompt, type PermissionRequest } from './PermissionPrompt.js';
import { AskUserPrompt, type AskUserRequest } from './AskUserPrompt.js';
import { ToolChip } from './ToolChip.js';
import type { TranscriptItem } from './types.js';

const TOOL_SUMMARY_CHARS = 400;

export interface AppProps {
  provider: Provider;
  profile: ProviderProfileConfig;
  conversation: Conversation;
  historyStore: JsonConversationStore;
  executor: WorkspaceToolExecutor;
  checkpoint: SessionCheckpoint;
  permissions: PermissionEngine;
  shadowGit?: ShadowGit;
  tools: ToolDefinition[];
  nativeToolCalls: boolean;
  workspaceName: string;
  contextWindow: number;
}

export function App({
  provider,
  profile,
  conversation,
  historyStore,
  executor,
  checkpoint,
  permissions,
  shadowGit,
  tools,
  nativeToolCalls,
  workspaceName,
  contextWindow,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [items, setItems] = useState<TranscriptItem[]>(
    conversation.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ kind: 'message' as const, message: m })),
  );
  const itemsRef = useRef(items);
  const pushItem = (item: TranscriptItem) => {
    itemsRef.current = [...itemsRef.current, item];
    setItems(itemsRef.current);
  };

  const [liveText, setLiveText] = useState('');
  const [liveTool, setLiveTool] = useState<Extract<TranscriptItem, { kind: 'tool' }>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingPermission, setPendingPermission] = useState<{ req: PermissionRequest; resolve: (c: PermissionChoice) => void }>();
  const [pendingQuestion, setPendingQuestion] = useState<{ req: AskUserRequest; resolve: (a: string) => void }>();

  const abortRef = useRef<AbortController>();
  const toolCheckpoints = useRef(new Map<string, string>());
  const toolDescriptions = useRef(new Map<string, string>());

  useEffect(() => {
    permissions.attachRequester(
      (req) => new Promise<PermissionChoice>((resolve) => setPendingPermission({ req, resolve })),
    );
  }, [permissions]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy && abortRef.current) abortRef.current.abort();
      else exit();
    }
  });

  async function persist(): Promise<void> {
    const messages: StoredMessage[] = itemsRef.current
      .filter((i): i is Extract<TranscriptItem, { kind: 'message' }> => i.kind === 'message')
      .map((i) => i.message);
    conversation.messages = messages;
    conversation.updatedAt = Date.now();
    await historyStore.save(conversation);
  }

  /** /rewind [n] — undo the effects of the last n tool calls (default 1) via their shadow-git checkpoints. */
  async function handleRewind(arg: string): Promise<void> {
    if (!shadowGit) {
      pushItem({ kind: 'system', text: 'Rewind is unavailable — shadow git could not be initialized.' });
      return;
    }
    const n = Math.max(1, Number.parseInt(arg, 10) || 1);
    const toolItems = itemsRef.current.filter((i): i is Extract<TranscriptItem, { kind: 'tool' }> => i.kind === 'tool' && Boolean(i.checkpoint));
    const target = toolItems[toolItems.length - n];
    if (!target?.checkpoint) {
      pushItem({ kind: 'system', text: `No checkpoint ${n} step(s) back.` });
      return;
    }
    const restored = await shadowGit.restore(target.checkpoint);
    pushItem({
      kind: 'system',
      text:
        restored === undefined
          ? 'Rewind failed.'
          : `Rewound to before "${target.description}" (${restored.length} file(s) restored).`,
    });
  }

  async function handleCommand(input: string): Promise<boolean> {
    const [cmd, ...rest] = input.trim().split(/\s+/);
    switch (cmd) {
      case '/rewind':
        await handleRewind(rest[0] ?? '1');
        return true;
      case '/revert': {
        const reverted = await checkpoint.revertAll();
        pushItem({ kind: 'system', text: reverted.length > 0 ? `Reverted: ${reverted.join(', ')}` : 'Nothing to revert.' });
        return true;
      }
      case '/checkpoints': {
        const toolItems = itemsRef.current.filter((i): i is Extract<TranscriptItem, { kind: 'tool' }> => i.kind === 'tool' && Boolean(i.checkpoint));
        pushItem({
          kind: 'system',
          text:
            toolItems.length === 0
              ? 'No checkpoints yet.'
              : toolItems.map((t, i) => `${toolItems.length - i}. ${t.description}`).reverse().join('\n'),
        });
        return true;
      }
      default:
        return false;
    }
  }

  async function handleSubmit(text: string): Promise<void> {
    if (text.startsWith('/')) {
      if (await handleCommand(text)) return;
    }

    setError(undefined);
    setBusy(true);
    pushItem({ kind: 'message', message: { role: 'user', content: text } });
    setLiveText('');
    let acc = '';
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      await runAgent({
        provider,
        model: profile.agentModel || profile.model,
        task: text,
        workspaceName,
        tools,
        nativeToolCalls,
        contextWindow,
        signal: abort.signal,
        execute: async (call) => {
          if (call.name === 'ask_user') {
            const options = Array.isArray(call.args.options) ? call.args.options.map(String) : undefined;
            const answer = await new Promise<string>((resolve) =>
              setPendingQuestion({ req: { question: String(call.args.question ?? ''), options }, resolve }),
            );
            setPendingQuestion(undefined);
            return {
              id: call.id,
              name: call.name,
              content: answer.trim() ? `User answered: ${answer}` : 'The user did not answer. Proceed with your best judgment.',
            };
          }
          return executor.execute(call, abort.signal);
        },
        requestPermission: (call, tool) => permissions.request(call, tool, executor.describe(call)),
        beforeToolCall: async (call) => {
          const hash = await shadowGit?.snapshot(`${call.name}: ${executor.describe(call).slice(0, 80)}`);
          if (hash) toolCheckpoints.current.set(call.id, hash);
        },
        events: {
          onText: (text) => pushItem({ kind: 'message', message: { role: 'assistant', content: text } }),
          onTextDelta: (chunk) => {
            acc += chunk;
            setLiveText(acc);
          },
          onTextEnd: () => {
            if (acc.trim()) pushItem({ kind: 'message', message: { role: 'assistant', content: acc } });
            acc = '';
            setLiveText('');
          },
          onPlan: (planText) => pushItem({ kind: 'plan', text: planText }),
          onToolCall: (call) => {
            const description = call.name === 'ask_user' ? `Ask: ${String(call.args.question ?? '').slice(0, 80)}` : executor.describe(call);
            toolDescriptions.current.set(call.id, description);
            setLiveTool({ kind: 'tool', id: call.id, name: call.name, description, status: 'running' });
          },
          onToolResult: (result) => {
            setLiveTool(undefined);
            pushItem({
              kind: 'tool',
              id: result.id,
              name: result.name,
              description: toolDescriptions.current.get(result.id) ?? result.name,
              status: result.isError ? 'error' : 'ok',
              summary: result.content.slice(0, TOOL_SUMMARY_CHARS),
              checkpoint: toolCheckpoints.current.get(result.id),
            });
          },
        },
      });
      await persist();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLiveText('');
      setLiveTool(undefined);
      setBusy(false);
      abortRef.current = undefined;
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, i) => {
          switch (item.kind) {
            case 'message':
              return <MessageView key={i} message={item.message} />;
            case 'tool':
              return <ToolChip key={item.id} item={item} />;
            case 'plan':
              return (
                <Box key={i} flexDirection="column" marginBottom={1} borderStyle="round" borderColor="blue" paddingX={1}>
                  <Text color="blue" bold>
                    Plan
                  </Text>
                  <Text>{item.text}</Text>
                </Box>
              );
            case 'system':
              return (
                <Box key={i} marginBottom={1}>
                  <Text dimColor>{item.text}</Text>
                </Box>
              );
          }
        }}
      </Static>
      {liveTool && <ToolChip item={liveTool} />}
      {busy && (
        <Box marginBottom={1} flexDirection="column">
          {liveText ? (
            <MessageView message={{ role: 'assistant', content: liveText }} />
          ) : !liveTool ? (
            <Text dimColor>
              <Spinner type="dots" /> working…
            </Text>
          ) : null}
        </Box>
      )}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
      {pendingPermission && (
        <PermissionPrompt
          request={pendingPermission.req}
          onChoice={(choice) => {
            pendingPermission.resolve(choice);
            setPendingPermission(undefined);
          }}
        />
      )}
      {pendingQuestion && (
        <AskUserPrompt
          request={pendingQuestion.req}
          onAnswer={(answer) => {
            pendingQuestion.resolve(answer);
            setPendingQuestion(undefined);
          }}
        />
      )}
      <Composer onSubmit={handleSubmit} disabled={busy || Boolean(pendingPermission) || Boolean(pendingQuestion)} />
      <Text dimColor>
        {profile.name} · {profile.model} · Ctrl+C to {busy ? 'stop' : 'exit'}
      </Text>
    </Box>
  );
}
