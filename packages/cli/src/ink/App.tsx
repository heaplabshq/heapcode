import React, { useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { ChatMessage, Conversation, Provider, ProviderProfileConfig } from '@heapcode/core';
import type { JsonConversationStore } from '../history/store.js';
import { sendMessage } from '../session.js';
import { Composer } from './Composer.js';
import { MessageView } from './MessageView.js';

export interface AppProps {
  provider: Provider;
  profile: ProviderProfileConfig;
  conversation: Conversation;
  historyStore: JsonConversationStore;
}

export function App({ provider, profile, conversation, historyStore }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>(conversation.messages);
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
  });

  async function handleSubmit(text: string): Promise<void> {
    setError(undefined);
    setBusy(true);
    setStreaming('');
    let acc = '';
    try {
      const { userMessage, assistantMessage } = await sendMessage({
        provider,
        profile,
        history: messages,
        userText: text,
        onDelta: (chunk) => {
          acc += chunk;
          setStreaming(acc);
        },
      });
      const next = [...messages, userMessage, assistantMessage];
      setMessages(next);
      conversation.messages = next as Conversation['messages'];
      conversation.updatedAt = Date.now();
      await historyStore.save(conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming('');
      setBusy(false);
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={messages}>{(m, i) => <MessageView key={i} message={m} />}</Static>
      {busy && (
        <Box marginBottom={1} flexDirection="column">
          {streaming ? (
            <MessageView message={{ role: 'assistant', content: streaming }} />
          ) : (
            <Text dimColor>
              <Spinner type="dots" /> thinking…
            </Text>
          )}
        </Box>
      )}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
      <Composer onSubmit={handleSubmit} disabled={busy} />
      <Text dimColor>
        {profile.name} · {profile.model}
      </Text>
    </Box>
  );
}
