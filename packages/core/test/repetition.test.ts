import { describe, expect, it } from 'vitest';
import { runAgent, type AgentOptions } from '../src/agent/loop.js';
import { REPETITION_NOTICE, REPETITION_NUDGE, RepetitionWatch, isLooping } from '../src/agent/repetition.js';
import type { ToolCall } from '../src/agent/tools.js';
import type { ChatRequest, ChatResponse, Provider } from '../src/providers/types.js';

/** The loop as it was reported: one paragraph, over and over, in the model's thinking. */
const LOOP_BLOCK = `Wait, but \`<Navbar />\` doesn't have children. Let me look at the Navbar component.

Actually, the error is about the Shell component. Let me look at the Shell component. The Shell component has \`children\` in its props but it's not being passed. Actually, the error is at line 22, column 8 which is \`<Navbar />\`.

`;

function streamIn(watch: RepetitionWatch, text: string, piece = 7): number | undefined {
  for (let i = 0; i < text.length; i += piece) if (watch.push(text.slice(i, i + piece))) return i;
  return undefined;
}

describe('noticing a model going round in circles', () => {
  it('catches the reported loop within a few repeats', () => {
    const watch = new RepetitionWatch();
    const caughtAt = streamIn(watch, LOOP_BLOCK.repeat(30));
    expect(caughtAt).toBeDefined();
    // Three or four copies in, not thirty: the point is to stop paying for it.
    expect(caughtAt!).toBeLessThan(LOOP_BLOCK.length * 5);
  });

  it('leaves ordinary thinking alone, however long', () => {
    const prose = Array.from({ length: 80 }, (_, i) => `Step ${i}: I read file ${i}.ts and found function f${i} returning ${i * 7}; next I check its caller in module m${i % 9}.`).join('\n');
    expect(streamIn(new RepetitionWatch(), prose)).toBeUndefined();
  });

  it('leaves short, normal repeats alone', () => {
    const text = 'Let me check.\n'.repeat(200) + '-'.repeat(2000) + '}\n'.repeat(500);
    expect(streamIn(new RepetitionWatch(), text)).toBeUndefined();
  });

  it('is not fooled by line breaks changing between copies', () => {
    const variants = LOOP_BLOCK.replace(/\n\n/g, '\n');
    expect(isLooping(LOOP_BLOCK + variants + LOOP_BLOCK + variants)).toBe(true);
  });
});

/** A model whose thinking loops — until it is told it was looping, `fixed` times. */
function loopingProvider(options: { loopsLeft: number; rejectPenalties?: boolean }): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let loopsLeft = options.loopsLeft;
  const provider: Provider = {
    chat: () => Promise.reject(new Error('streams only')),
    async chatStreamed(req: ChatRequest, onDelta?: (t: string, kind?: 'text' | 'reasoning' | 'tool') => void): Promise<ChatResponse> {
      requests.push({ ...req, signal: undefined });
      if (options.rejectPenalties && req.frequencyPenalty !== undefined) throw new Error('400 unknown parameter frequency_penalty');
      const nudged = req.messages.some((m) => m.content === REPETITION_NUDGE);
      if (loopsLeft > 0 && (!nudged || loopsLeft > 1 || requests.length > 1)) {
        loopsLeft -= 1;
        // Thinks in circles until the request is cut off, as a real stream does.
        for (let i = 0; i < 400; i += 1) {
          if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          onDelta?.(LOOP_BLOCK.slice(0, 60), 'reasoning');
          onDelta?.(LOOP_BLOCK.slice(60), 'reasoning');
        }
        return { content: 'never reached' };
      }
      onDelta?.('Reading the Navbar now.', 'text');
      return { content: 'Fixed: Shell now receives children.', toolCalls: [] };
    },
    streamChat() {
      throw new Error('not used');
    },
    completion() {
      throw new Error('not used');
    },
    embeddings() {
      throw new Error('not used');
    },
    listModels: () => Promise.resolve([]),
  };
  return { provider, requests };
}

function harness(provider: Provider): { texts: string[]; reasoning: string[]; options: AgentOptions } {
  const texts: string[] = [];
  const reasoning: string[] = [];
  return {
    texts,
    reasoning,
    options: {
      provider,
      model: 'test',
      task: 'fix the type error',
      workspaceName: 'demo',
      tools: [],
      nativeToolCalls: true,
      execute: (call: ToolCall) => Promise.resolve({ id: call.id, name: call.name, content: 'ok' }),
      requestPermission: () => Promise.resolve(true),
      events: {
        onText: (t) => texts.push(t),
        onToolCall: () => {},
        onToolResult: () => {},
        onReasoningDelta: (t) => reasoning.push(t),
      },
    },
  };
}

describe('the agent loop, when a reply loops', () => {
  it('stops it, says so, and asks once more — told, warmer, steered off repeating', async () => {
    const { provider, requests } = loopingProvider({ loopsLeft: 1 });
    const h = harness(provider);
    const outcome = await runAgent(h.options);
    expect(outcome).toBe('done');
    expect(h.texts[0]).toBe(REPETITION_NOTICE);
    // Cut off early: a few copies of the block, not four hundred.
    expect(h.reasoning.join('').length).toBeLessThan(LOOP_BLOCK.length * 6);

    const retry = requests[1]!;
    expect(retry.messages.at(-1)).toEqual({ role: 'user', content: REPETITION_NUDGE });
    expect(retry.temperature).toBeGreaterThanOrEqual(0.7);
    expect(retry.frequencyPenalty).toBeGreaterThan(0);
    // The first request was an ordinary one.
    expect(requests[0]!.frequencyPenalty).toBeUndefined();
  });

  it('still nudges an endpoint that refuses the penalty settings', async () => {
    const { provider, requests } = loopingProvider({ loopsLeft: 1, rejectPenalties: true });
    const outcome = await runAgent(harness(provider).options);
    expect(outcome).toBe('done');
    // Request 2 asked with penalties and was refused; request 3 is the nudge without them.
    expect(requests[1]!.frequencyPenalty).toBeGreaterThan(0);
    expect(requests[2]!.frequencyPenalty).toBeUndefined();
    expect(requests[2]!.messages.at(-1)!.content).toBe(REPETITION_NUDGE);
  });

  it('gives up with a clear message when it loops again', async () => {
    const { provider } = loopingProvider({ loopsLeft: 5 });
    const h = harness(provider);
    // The loop reports a failed run as an error outcome with the reason as text, not a throw.
    expect(await runAgent(h.options)).toBe('error');
    expect(h.texts.at(-1)).toMatch(/kept repeating itself/);
  });
});
