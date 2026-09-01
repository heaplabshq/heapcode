import * as vscode from 'vscode';
import {
  buildChatCompletionMessages,
  cleanCompletion,
  detectFimTemplate,
  getFimTemplate,
  isAbortError,
  LatencyTracker,
  PrefixCache,
  type HitMeta,
  type KeywordIndex,
} from '@heapcode/core';
import type { ProfileManager } from './profileManager.js';
import type { ServerLink } from './serverLink.js';

const PREFIX_CHARS = 6000;
const SUFFIX_CHARS = 2000;
const CROSS_FILE_CHARS = 1500;
const SNIPPET_CHARS = 700;
const REPO_CONTEXT_CHARS = 1200;
const REPO_QUERY_LINES = 10;
const REPO_QUERY_CHARS = 500;

const HASH_COMMENT_LANGS = new Set(['python', 'ruby', 'shellscript', 'yaml', 'perl', 'r', 'makefile', 'dockerfile', 'toml']);

export class HeapCodeCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new PrefixCache();
  private readonly latency = new LatencyTracker();

  constructor(
    private readonly profiles: ProfileManager,
    private readonly log: vscode.OutputChannel,
    /**
     * The semantic index, over the socket. Only a *manual* trigger reaches it:
     * the user is explicitly waiting, so a round-trip plus an embedding call
     * is affordable there and nowhere else on this path.
     */
    private readonly link: ServerLink,
    /**
     * Vector-free BM25 over the same chunks, held in this process. Typing
     * triggers retrieve from here rather than from the semantic index, which
     * is what keeps the keystroke path free of I/O — see its own doc comment
     * and docs/phase3-rag-design.md §2.3.
     */
    private readonly keywords: KeywordIndex,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = vscode.workspace.getConfiguration('heapcode.completion');
    if (!cfg.get<boolean>('enable', true)) return;
    if (
      cfg.get<string>('triggerMode', 'auto') === 'manual' &&
      context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
    ) {
      return;
    }
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return;

    const prefix = document
      .getText(new vscode.Range(new vscode.Position(0, 0), position))
      .slice(-PREFIX_CHARS);
    if (!prefix.trim()) return;
    const suffix = document
      .getText(
        new vscode.Range(position, new vscode.Position(document.lineCount, 0)),
      )
      .slice(0, SUFFIX_CHARS);

    // Instant path: the user is typing through the previous suggestion.
    const cached = this.cache.get(document.uri.toString(), prefix);
    if (cached) {
      return [acceptTrackedItem(cached, position, document.uri)];
    }

    // Debounce: VS Code cancels this call on the next keystroke.
    await delay(cfg.get<number>('delay', 250));
    if (token.isCancellationRequested) return;

    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    const resolved = await this.profiles.resolveRole('completion');
    // `profile.model` IS the completion model — a resolved role arrives
    // flattened, having already walked the chain (completion → chat).
    const model = resolved?.profile.model;
    if (!resolved || !model) return;
    const { provider, profile } = resolved;

    const templateSetting = cfg.get<string>('template', 'auto');
    const template =
      templateSetting === 'chat'
        ? undefined
        : templateSetting === 'auto'
          ? detectFimTemplate(model)
          : getFimTemplate(templateSetting);

    // Single-line mode when there's code after the cursor on the same line.
    const lineSuffix = document.lineAt(position.line).text.slice(position.character);
    const singleLine = lineSuffix.trim().length > 0;
    const maxLines = singleLine ? 1 : cfg.get<number>('maxLines', 12);

    // Ollama applies the model's own FIM template server-side via the
    // `suffix` param — more reliable than hand-rendered FIM token strings.
    const nativeFim = profile.preset === 'ollama' && templateSetting === 'auto' && template;

    const repoContext = cfg.get<boolean>('repoContext', true)
      ? await collectRepoContext(this.link, this.keywords, document, prefix, context.triggerKind)
      : '';
    const crossFile = collectCrossFileContext(document);
    const started = Date.now();
    let mode: string;
    let raw: string;
    try {
      if (nativeFim) {
        mode = 'fim:native';
        const res = await provider.completion({
          model,
          prompt: repoContext + crossFile + prefix,
          suffix,
          maxTokens: cfg.get<number>('maxTokens', 200),
          temperature: 0,
          stop: singleLine ? ['\n'] : undefined,
          signal: abort.signal,
        });
        raw = res.text;
      } else if (template) {
        mode = `fim:${template.id}`;
        const res = await provider.completion({
          model,
          prompt: template.render(repoContext + crossFile + prefix, suffix),
          maxTokens: cfg.get<number>('maxTokens', 200),
          temperature: 0,
          stop: singleLine ? ['\n', ...template.stop] : template.stop,
          signal: abort.signal,
        });
        raw = res.text;
      } else {
        mode = 'chat';
        const res = await provider.chat({
          model,
          messages: buildChatCompletionMessages({
            prefix: repoContext + crossFile + prefix,
            suffix,
            languageId: document.languageId,
          }),
          maxTokens: cfg.get<number>('maxTokens', 200),
          temperature: 0,
          signal: abort.signal,
        });
        raw = res.content;
      }
    } catch (err) {
      if (!isAbortError(err)) {
        this.log.appendLine(`[completion] error: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    const elapsed = Date.now() - started;
    this.latency.record(elapsed);
    this.log.appendLine(
      `[completion] ${elapsed}ms · ${mode} · ${model} · ${this.latency.summary()}`,
    );

    if (token.isCancellationRequested) return;
    const text = cleanCompletion(raw, { prefix, suffix, maxLines });
    if (!text) {
      this.log.appendLine(
        raw.trim()
          ? `[completion] filtered (${raw.length} chars): "${preview(raw)}"`
          : '[completion] model returned empty output',
      );
      return;
    }

    this.cache.set(document.uri.toString(), prefix, text);
    return [acceptTrackedItem(text, position, document.uri)];
  }
}

/**
 * An inline completion item whose `command` fires on accept (Tab) — not on
 * partial/word-by-word accept, which VS Code doesn't route through `command`,
 * but that's an acceptable gap for a coarse accept/retention signal.
 */
function acceptTrackedItem(
  text: string,
  position: vscode.Position,
  uri: vscode.Uri,
): vscode.InlineCompletionItem {
  const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  item.command = {
    command: 'heapcode.completionAccepted',
    title: '',
    arguments: [uri.toString(), text],
  };
  return item;
}

/**
 * Similar snippets from elsewhere in the repo (via the semantic-search
 * index), as commented-out context — the same idea as collectCrossFileContext
 * but sourced from the whole workspace instead of just open editors.
 * Typing-triggered completions use BM25-only retrieval (no model call, safe
 * inside the debounce window); manual-trigger completions use the fuller
 * embeddings+hybrid+rerank pipeline since the user is explicitly waiting.
 */
/**
 * Exported for tests: which index a completion's repo context comes from is
 * the whole of decision 1 in the RAG migration, and it is not observable
 * through provideInlineCompletionItems without standing up the model call too.
 */
export async function collectRepoContext(
  link: Pick<ServerLink, 'ragQuery'>,
  keywords: KeywordIndex,
  current: vscode.TextDocument,
  prefix: string,
  triggerKind: vscode.InlineCompletionTriggerKind,
): Promise<string> {
  const invoked = triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
  if (!invoked && !keywords.ready) return '';
  const queryText = prefix.split('\n').slice(-REPO_QUERY_LINES).join('\n').slice(-REPO_QUERY_CHARS);
  if (!queryText.trim()) return '';

  const currentPath = vscode.workspace.asRelativePath(current.uri, false);
  const hits: HitMeta[] = invoked ? (await link.ragQuery(queryText, 4)).hits : keywords.search(queryText, 4);

  const parts: string[] = [];
  let used = 0;
  for (const hit of hits) {
    if (hit.path === currentPath) continue;
    const commented = commentOut(
      `From ${hit.path}:${hit.startLine}-${hit.endLine}:\n${hit.text}`,
      current.languageId,
    );
    if (used + commented.length > REPO_CONTEXT_CHARS) break;
    parts.push(commented);
    used += commented.length;
  }
  return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

/** Short snippets from other visible editors, as commented-out context. */
function collectCrossFileContext(current: vscode.TextDocument): string {
  const parts: string[] = [];
  let used = 0;
  for (const editor of vscode.window.visibleTextEditors) {
    const doc = editor.document;
    if (doc.uri.toString() === current.uri.toString()) continue;
    if (doc.uri.scheme !== 'file') continue;
    const snippet = snippetAround(doc, editor.selection.active);
    const commented = commentOut(
      `From ${vscode.workspace.asRelativePath(doc.uri, false)}:\n${snippet}`,
      current.languageId,
    );
    if (used + commented.length > CROSS_FILE_CHARS) break;
    parts.push(commented);
    used += commented.length;
  }
  return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

function snippetAround(doc: vscode.TextDocument, pos: vscode.Position): string {
  const start = Math.max(0, pos.line - 15);
  const end = Math.min(doc.lineCount - 1, pos.line + 15);
  return doc.getText(new vscode.Range(start, 0, end, 1000)).slice(0, SNIPPET_CHARS);
}

function commentOut(text: string, languageId: string): string {
  const marker = HASH_COMMENT_LANGS.has(languageId) ? '#' : '//';
  return text
    .split('\n')
    .map((l) => `${marker} ${l}`)
    .join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function preview(text: string): string {
  return text.slice(0, 140).replace(/\n/g, '\\n');
}
