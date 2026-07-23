import type { ChatMessage, Provider, ProviderProfileConfig } from '@heapcode/core';

export interface SendMessageOptions {
  provider: Provider;
  profile: ProviderProfileConfig;
  /** Prior turns, oldest first — does not include the new user message. */
  history: ChatMessage[];
  userText: string;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface SendMessageResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

/**
 * The one chat turn both the interactive Ink UI and the headless runner
 * call — kept host-agnostic on purpose (docs/CLI_PLAN.md guardrail #8:
 * headless is a first-class peer of the interactive UI, not a shortcut
 * bolted onto it later). No tools yet — CLI-M1 wires runAgent in for agent
 * mode; this is the CLI-M0 chat-only path.
 */
export async function sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
  const userMessage: ChatMessage = { role: 'user', content: opts.userText };
  const messages: ChatMessage[] = [...opts.history, userMessage];

  let content = '';
  if (opts.provider.chatStreamed) {
    const res = await opts.provider.chatStreamed(
      { model: opts.profile.model, messages, temperature: opts.profile.temperature, maxTokens: opts.profile.maxTokens, signal: opts.signal },
      (text, kind) => {
        if (kind === undefined || kind === 'text') opts.onDelta?.(text);
      },
    );
    content = res.content;
  } else {
    for await (const chunk of opts.provider.streamChat({
      model: opts.profile.model,
      messages,
      temperature: opts.profile.temperature,
      maxTokens: opts.profile.maxTokens,
      signal: opts.signal,
    })) {
      content += chunk.content;
      opts.onDelta?.(chunk.content);
    }
  }

  return { userMessage, assistantMessage: { role: 'assistant', content } };
}
