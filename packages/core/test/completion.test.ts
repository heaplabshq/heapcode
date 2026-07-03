import { afterEach, describe, expect, it } from 'vitest';
import { detectFimTemplate, getFimTemplate } from '../src/completion/fim.js';
import { cleanCompletion } from '../src/completion/postprocess.js';
import { PrefixCache } from '../src/completion/cache.js';
import { LatencyTracker } from '../src/completion/latency.js';
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { startMockServer, type MockServer } from './mockServer.js';

describe('detectFimTemplate', () => {
  it('maps model families to templates', () => {
    expect(detectFimTemplate('qwen2.5-coder:7b')?.id).toBe('qwen');
    expect(detectFimTemplate('deepseek-coder-v2:16b')?.id).toBe('deepseek');
    expect(detectFimTemplate('starcoder2:3b')?.id).toBe('starcoder');
    expect(detectFimTemplate('granite-code:8b')?.id).toBe('starcoder');
    expect(detectFimTemplate('codellama:13b')?.id).toBe('codellama');
    expect(detectFimTemplate('codestral-latest')?.id).toBe('codestral');
    expect(detectFimTemplate('codegemma:7b')?.id).toBe('codegemma');
  });

  it('returns undefined for chat-only models → fallback', () => {
    expect(detectFimTemplate('llama3.2')).toBeUndefined();
    expect(detectFimTemplate('gpt-4o')).toBeUndefined();
  });

  it('renders the qwen template with prefix and suffix in order', () => {
    const t = getFimTemplate('qwen')!;
    expect(t.render('AAA', 'BBB')).toBe('<|fim_prefix|>AAA<|fim_suffix|>BBB<|fim_middle|>');
  });

  it('codestral puts the suffix before the prefix', () => {
    const t = getFimTemplate('codestral')!;
    expect(t.render('P', 'S')).toBe('[SUFFIX]S[PREFIX]P');
  });
});

describe('cleanCompletion', () => {
  it('passes through a good completion', () => {
    expect(cleanCompletion('return a + b;', { suffix: '\n}', maxLines: 12 })).toBe('return a + b;');
  });

  it('strips markdown fences from chat-model output', () => {
    expect(cleanCompletion('```ts\nfoo();\n```', { suffix: '', maxLines: 12 })).toBe('foo();');
  });

  it('enforces the line limit', () => {
    const raw = 'l1\nl2\nl3\nl4';
    expect(cleanCompletion(raw, { suffix: '', maxLines: 2 })).toBe('l1\nl2');
  });

  it('trims the tail that regenerates the suffix', () => {
    // Model completed "return x;\n}" but "}" already exists after the cursor.
    expect(cleanCompletion('return x;\n}', { suffix: '}\nmore();', maxLines: 12 })).toBe(
      'return x;',
    );
  });

  it('rejects a completion that only repeats the next line', () => {
    expect(cleanCompletion('console.log(x);', { suffix: '\nconsole.log(x);\n', maxLines: 12 })).toBe(
      '',
    );
  });

  it('rejects whitespace-only output', () => {
    expect(cleanCompletion('  \n \n', { suffix: '', maxLines: 12 })).toBe('');
  });
});

describe('PrefixCache', () => {
  it('serves the remainder while the user types through the suggestion', () => {
    const cache = new PrefixCache();
    cache.set('file.ts', 'const x = ', 'foo(bar);');
    expect(cache.get('file.ts', 'const x = ')).toBe('foo(bar);');
    expect(cache.get('file.ts', 'const x = foo(')).toBe('bar);');
  });

  it('misses when typing diverges from the suggestion', () => {
    const cache = new PrefixCache();
    cache.set('file.ts', 'const x = ', 'foo(bar);');
    expect(cache.get('file.ts', 'const x = qux')).toBeUndefined();
  });

  it('misses across documents and when fully typed out', () => {
    const cache = new PrefixCache();
    cache.set('a.ts', 'p', 'q');
    expect(cache.get('b.ts', 'p')).toBeUndefined();
    expect(cache.get('a.ts', 'pq')).toBeUndefined();
  });
});

describe('LatencyTracker', () => {
  it('computes percentiles', () => {
    const t = new LatencyTracker();
    for (let i = 1; i <= 100; i++) t.record(i);
    expect(t.percentile(50)).toBe(50);
    expect(t.percentile(95)).toBe(95);
    expect(t.count).toBe(100);
  });
});

describe('provider.completion', () => {
  let server: MockServer;
  afterEach(async () => {
    await server?.close();
  });

  it('POSTs the raw prompt to /completions and returns the text', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: { choices: [{ text: ' + 1;' }] },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const res = await provider.completion({
      model: 'qwen2.5-coder',
      prompt: '<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>',
      stop: ['<|endoftext|>'],
      maxTokens: 64,
    });
    expect(res.text).toBe(' + 1;');
    const req = server.requests[0]!;
    expect(req.path).toBe('/v1/completions');
    expect(req.body).toMatchObject({
      model: 'qwen2.5-coder',
      prompt: '<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>',
      stream: false,
    });
  });
});
