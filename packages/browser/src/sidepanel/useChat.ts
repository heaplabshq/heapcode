import { useCallback, useRef, useState } from 'react';
import { createProvider } from '@heapcode/core/providers';
import type { ChatMessage } from '@heapcode/core/providers';
import { ProviderError } from '@heapcode/core/providers';
import { estimateMessagesTokens } from '@heapcode/core/context';
import { resolveContextWindow } from '@heapcode/core/providers';
import { loadApiKey, type StoredProfile } from '../shared/settings.js';
import { readActivePage } from './page.js';
import { SYSTEM_PROMPT } from './prompt.js';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Set when the turn ended badly; rendered differently from model prose. */
  error?: string;
  /** True while tokens are still arriving for this turn. */
  streaming?: boolean;
}

/**
 * The chat turn, streamed.
 *
 * M0 has no agent loop and no tools on purpose — this exists to prove the pipe
 * end to end (panel → provider → streamed reply → stop) before any page access
 * is built. The loop arrives in M2 and will run in this same page, never in the
 * service worker (PRD §7.1).
 *
 * Cancellation is a real `AbortSignal` handed to the provider, not a flag that
 * hides late tokens. A stop button that only stops the UI leaves the request
 * running and still being billed, which is the version of this that users
 * notice and we would not.
 */
export function useChat(profile: StoredProfile) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastPromptTokens, setLastPromptTokens] = useState(0);
  const abort = useRef<AbortController | undefined>(undefined);

  const stop = useCallback(() => {
    abort.current?.abort();
  }, []);

  const send = useCallback(
    async (text: string, includePage = false) => {
      if (busy || text.trim().length === 0) return;

      setTurns((prev) => [
        ...prev,
        { role: 'user', content: text },
        { role: 'assistant', content: '', streaming: true },
      ]);
      setBusy(true);

      // The user's own message is the intent that ranks the snapshot, so the
      // control they are pointing at survives truncation on a page with
      // hundreds of them.
      let page: string | undefined;
      let pageError: string | undefined;
      if (includePage) {
        const result = await readActivePage(text);
        if (result.ok) page = result.text;
        else pageError = result.reason;
      }

      const history: ChatMessage[] = [
        // The system role is the only channel carrying instructions. Page text
        // arrives as a user-role message and is marked untrusted, so the two
        // stay structurally distinct (PRD §6.1).
        { role: 'system', content: SYSTEM_PROMPT },
        ...turns
          .filter((t) => !t.error)
          .map((t) => ({ role: t.role, content: t.content }) satisfies ChatMessage),
      ];
      // Kept as its own message rather than concatenated onto the question, so
      // the untrusted notice covers the page and nothing else. M2 replaces this
      // with a real tool result, which is the structurally distinct channel
      // PRD §6.1 actually wants; until the loop exists there is no tool role to
      // put it in.
      if (page) history.push({ role: 'user', content: page });
      history.push({ role: 'user', content: text });

      if (pageError) {
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last) next[next.length - 1] = { ...last, streaming: false, error: pageError };
          return next;
        });
        setBusy(false);
        return;
      }

      setLastPromptTokens(estimateMessagesTokens(history));

      const controller = new AbortController();
      abort.current = controller;

      /** Replace the trailing assistant turn — the one being streamed into. */
      const updateLast = (patch: Partial<Turn>) =>
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last) next[next.length - 1] = { ...last, ...patch };
          return next;
        });

      try {
        const apiKey = await loadApiKey();
        const provider = createProvider(profile, apiKey);
        let content = '';

        const request = {
          model: profile.model,
          messages: history,
          signal: controller.signal,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
        };

        // Prefer the streamed transport: it is the one that surfaces tokens as
        // they arrive, and reasoning models can outlast any sane non-streaming
        // timeout while still producing bytes immediately.
        if (provider.chatStreamed) {
          const response = await provider.chatStreamed(request, (delta, kind) => {
            // 'reasoning' deltas are the model thinking aloud and 'tool' deltas
            // are argument fragments. Neither is the answer, so neither is
            // shown as one.
            if (kind && kind !== 'text') return;
            content += delta;
            updateLast({ content });
          });
          updateLast({ content: response.content || content, streaming: false });
        } else {
          for await (const chunk of provider.streamChat(request)) {
            content += chunk.content;
            updateLast({ content });
          }
          updateLast({ content, streaming: false });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          updateLast({ streaming: false, error: 'Stopped.' });
        } else if (error instanceof ProviderError) {
          updateLast({ streaming: false, error: error.message });
        } else {
          updateLast({
            streaming: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        abort.current = undefined;
        setBusy(false);
      }
    },
    [busy, profile, turns],
  );

  const clear = useCallback(() => {
    setTurns([]);
    setLastPromptTokens(0);
  }, []);

  return {
    turns,
    busy,
    send,
    stop,
    clear,
    tokens: lastPromptTokens,
    contextWindow: resolveContextWindow(profile),
  };
}
