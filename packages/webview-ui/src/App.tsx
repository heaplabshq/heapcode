import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangedFile,
  ConversationMeta,
  ExtensionToWebview,
  FileEditInfo,
  PermissionChoice,
  SlashCommandInfo,
} from '@heapcode/core';
import { postToExtension } from './vscodeApi.js';
import { renderMarkdown } from './markdown.js';
import { SettingsView, type SettingsData } from './SettingsView.js';

interface ToolChip {
  id: string;
  name: string;
  description: string;
  done: boolean;
  ok?: boolean;
  summary?: string;
  label?: string;
  fileEdit?: FileEditInfo;
  terminalCommand?: string;
  expanded?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  done: 'Completed',
  stopped: 'Stopped',
  'max-iterations': 'Stopped at iteration limit',
  error: 'Failed',
};

const REFERENCE_PATTERN = /^[.#]?[\w@-]+([./\\-][\w@-]+)*(\.\w+)?$/;

const MAX_IMAGES = 4;
const MAX_IMAGE_DIMENSION = 1568;

/**
 * Pasted/dropped image → data URL. Large images are downscaled and
 * re-encoded as JPEG so a 5 MB screenshot doesn't blow up the prompt.
 */
async function imageToDataUrl(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && blob.size <= 1_000_000) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function IconHistory() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 2a6 6 0 1 1-5.2 3H1.5L4 1.5 6.5 5H4.1A5 5 0 1 0 8 3V2z" />
      <path d="M7.5 4.5h1V8l2.8 1.6-.5.9L7.5 8.6V4.5z" />
    </svg>
  );
}

function IconNew() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8.5 3h-1v4.5H3v1h4.5V13h1V8.5H13v-1H8.5V3z" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M9.1 1.5l.4 1.8c.4.1.8.3 1.1.5l1.7-.8 1.1 1.9-1.4 1.2c.1.4.1.8 0 1.2l1.4 1.2-1.1 1.9-1.7-.8c-.3.2-.7.4-1.1.5l-.4 1.8H6.9l-.4-1.8c-.4-.1-.8-.3-1.1-.5l-1.7.8-1.1-1.9L4 7.3c-.1-.4-.1-.8 0-1.2L2.6 4.9l1.1-1.9 1.7.8c.3-.2.7-.4 1.1-.5l.4-1.8h2.2zM8 5.2A2.2 2.2 0 1 0 8 9.6 2.2 2.2 0 0 0 8 5.2z" transform="translate(0 1.3)" />
    </svg>
  );
}

interface PermissionCard {
  id: string;
  description: string;
  permission: string;
  allowPersist: boolean;
  decided?: PermissionChoice;
}

interface QuestionCard {
  id: string;
  question: string;
  options?: string[];
  answered?: string;
}

interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  tool?: ToolChip;
  plan?: boolean;
  permission?: PermissionCard;
  question?: QuestionCard;
  /** Images attached to a user turn (data: URLs). */
  images?: string[];
  agentStatus?: { state: string; changedFiles: ChangedFile[] };
  attachedFiles?: string[];
  /** Live agent narration still receiving deltas. */
  agentStreaming?: boolean;
  /** Reasoning ("thinking") stream from reasoning models. */
  reasoning?: boolean;
  collapsed?: boolean;
  /** Small centered system note (e.g. "context compacted"). */
  note?: boolean;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const WINDOW_SOURCE_LABEL: Record<string, string> = {
  profile: 'profile setting (contextWindow)',
  model: 'reported by the provider for this model',
  preset: 'provider preset default',
  default: 'fallback default — set contextWindow on the profile if your model has more',
};

/** Ring meter showing how much of the model's context window is in use; click for details. */
function ContextMeter({
  used,
  window: win,
  source,
  onOpenSettings,
}: {
  used: number;
  window: number;
  source?: string;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pct = Math.min(1, used / Math.max(1, win));
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const color =
    pct > 0.9
      ? 'var(--vscode-editorError-foreground)'
      : pct > 0.7
        ? 'var(--vscode-editorWarning-foreground)'
        : 'var(--vscode-descriptionForeground)';
  return (
    <span className="context-meter-wrap" ref={ref}>
      {open && (
        <div className="context-popup">
          <div className="context-popup-title">Context window</div>
          <div className="context-popup-row">
            <span>Used</span>
            <span>
              ~{formatTokens(used)} / {formatTokens(win)} tokens ({Math.round(pct * 100)}%)
            </span>
          </div>
          <div className="context-popup-bar">
            <div className="context-popup-fill" style={{ width: `${pct * 100}%`, background: color }} />
          </div>
          {source && (
            <div className="context-popup-row">
              <span>Window size</span>
              <span>{WINDOW_SOURCE_LABEL[source] ?? source}</span>
            </div>
          )}
          <div className="context-popup-note">
            Older turns are compacted automatically as usage approaches ~80%.
          </div>
          <button
            className="ghost context-popup-link"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Override in profile settings…
          </button>
        </div>
      )}
      <button
        className="context-meter"
        title={`Context window: ~${formatTokens(used)} of ${formatTokens(win)} tokens used (${Math.round(pct * 100)}%). Click for details.`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <circle cx="7" cy="7" r={radius} fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="2.5" />
          <circle
            cx="7"
            cy="7"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeDasharray={`${pct * circumference} ${circumference}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
        <span className="context-meter-pct" style={{ color }}>
          {Math.round(pct * 100)}%
        </span>
      </button>
    </span>
  );
}

/** The agent's ask_user tool: option buttons plus a free-text answer field. */
function QuestionCardView({
  q,
  onAnswer,
}: {
  q: QuestionCard;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="question-card">
      <div className="question-head">Heap Code has a question</div>
      <div className="question-text">{q.question}</div>
      {q.answered !== undefined ? (
        <div className="question-answered">↳ {q.answered}</div>
      ) : (
        <>
          {q.options && q.options.length > 0 && (
            <div className="question-options">
              {q.options.map((opt) => (
                <button key={opt} className="ghost" onClick={() => onAnswer(opt)}>
                  {opt}
                </button>
              ))}
            </div>
          )}
          <div className="question-input-row">
            <input
              className="question-input"
              value={text}
              placeholder="Type an answer…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) onAnswer(text.trim());
              }}
            />
            <button
              className="primary"
              disabled={!text.trim()}
              onClick={() => onAnswer(text.trim())}
            >
              Answer
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface ModelMenu {
  loading: boolean;
  profiles: Array<{ name: string; active: boolean }>;
  models: string[];
}

interface Config {
  profile: string;
  model: string;
  slashCommands: SlashCommandInfo[];
}

export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<'chat' | 'history' | 'settings'>('chat');
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [history, setHistory] = useState<ConversationMeta[]>([]);
  const [mode, setMode] = useState<'chat' | 'agent'>('chat');
  const [agentRunning, setAgentRunning] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [currentSelection, setCurrentSelection] = useState<{ start: number; end: number } | null>(
    null,
  );
  const [includeCurrentFile, setIncludeCurrentFile] = useState(true);
  const [modelMenu, setModelMenu] = useState<ModelMenu | null>(null);
  const [toolStreamChars, setToolStreamChars] = useState(0);
  const [contextUsage, setContextUsage] = useState<{
    used: number;
    window: number;
    source?: string;
  } | null>(null);
  /** Ordinal (Nth user message) being edited; sending truncates + resends from there. */
  const [editing, setEditing] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modePickerRef = useRef<HTMLDivElement>(null);
  const plusPickerRef = useRef<HTMLDivElement>(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const toolsPickerRef = useRef<HTMLDivElement>(null);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [toolGroups, setToolGroups] = useState<
    Array<{
      id: string;
      label: string;
      tools: Array<{ name: string; label: string; description: string; enabled: boolean }>;
    }>
  >([]);
  const [collapsedToolGroups, setCollapsedToolGroups] = useState<Record<string, boolean>>({});
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  /** Explorer drags carry a uri-list; hand it to the extension to resolve files vs folders. */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const uriList = e.dataTransfer.getData('text/uri-list');
    const uris = uriList
      .split(/[\r\n]+/)
      .map((u) => u.trim())
      .filter((u) => u && !u.startsWith('#'));
    if (uris.length > 0) postToExtension({ type: 'resolveDropped', uris });
  };

  // Popover dismissal: Esc anywhere, or clicking outside the open picker.
  useEffect(() => {
    if (!modelMenu && !modeMenuOpen && !plusMenuOpen && !toolsMenuOpen) return;
    const closeAll = () => {
      setModelMenu(null);
      setModeMenuOpen(false);
      setPlusMenuOpen(false);
      setToolsMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !modelPickerRef.current?.contains(target) &&
        !modePickerRef.current?.contains(target) &&
        !plusPickerRef.current?.contains(target) &&
        !toolsPickerRef.current?.contains(target)
      ) {
        closeAll();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [modelMenu, modeMenuOpen, plusMenuOpen, toolsMenuOpen]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'config':
          setConfig({ profile: msg.profile, model: msg.model, slashCommands: msg.slashCommands });
          break;
        case 'activeFile':
          setCurrentFile(msg.path);
          setCurrentSelection(msg.selection ?? null);
          break;
        case 'chunk':
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant' && !last.tool && !last.agentStatus) {
              next[next.length - 1] = { ...last, content: last.content + msg.text };
            }
            return next;
          });
          break;
        case 'done':
          setStreaming(false);
          break;
        case 'error':
          setStreaming(false);
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant' && last.content === '' && !last.tool) {
              next[next.length - 1] = { role: 'assistant', content: msg.message, error: true };
            } else {
              next.push({ role: 'assistant', content: msg.message, error: true });
            }
            return next;
          });
          break;
        case 'userMessage':
          setView('chat');
          setStreaming(true);
          setMessages((prev) => [
            ...prev,
            { role: 'user', content: msg.text },
            { role: 'assistant', content: '' },
          ]);
          break;
        case 'userTurn':
          setView('chat');
          setMessages((prev) => [
            ...prev,
            { role: 'user', content: msg.text, attachedFiles: msg.files },
          ]);
          break;
        case 'history':
          setHistory(msg.items);
          break;
        case 'conversation':
          setMessages(
            msg.messages.map((m): UiMessage => {
              if (m.tool) {
                return {
                  role: 'assistant',
                  content: '',
                  tool: { id: '', done: true, ...m.tool },
                };
              }
              if (m.status) {
                return {
                  role: 'assistant',
                  content: '',
                  agentStatus: { state: m.status.state, changedFiles: [] },
                };
              }
              return { role: m.role, content: m.content, plan: m.plan, images: m.images };
            }),
          );
          setView('chat');
          setStreaming(false);
          break;
        case 'newChatStarted':
          setMessages([]);
          setView('chat');
          setStreaming(false);
          break;
        case 'contextFiles':
          setAttached((prev) => [...new Set([...prev, ...msg.files])]);
          break;
        case 'imageAttachments':
          setPendingImages((prev) => [...prev, ...msg.images].slice(0, MAX_IMAGES));
          break;
        case 'toolsList':
          setToolGroups(msg.groups);
          break;
        case 'models':
          setModelMenu({ loading: false, profiles: msg.profiles, models: msg.models });
          break;
        case 'settingsData':
          setSettingsData({
            profiles: msg.profiles,
            active: msg.active,
            presets: msg.presets,
            keySaved: msg.keySaved,
          });
          break;
        case 'permissionRequest':
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: '',
              permission: {
                id: msg.id,
                description: msg.description,
                permission: msg.permission,
                allowPersist: msg.allowPersist,
              },
            },
          ]);
          break;
        case 'agentQuestion':
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: '',
              question: { id: msg.id, question: msg.question, options: msg.options },
            },
          ]);
          break;
        case 'agentText':
          setMessages((prev) => [...prev, { role: 'assistant', content: msg.text }]);
          break;
        case 'agentTextDelta':
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.agentStreaming) {
              next[next.length - 1] = { ...last, content: last.content + msg.text };
              return next;
            }
            return [...next, { role: 'assistant', content: msg.text, agentStreaming: true }];
          });
          break;
        case 'agentTextEnd':
          setMessages((prev) =>
            prev.map((m) => (m.agentStreaming ? { ...m, agentStreaming: false } : m)),
          );
          break;
        case 'agentReasoningDelta':
          setToolStreamChars(0);
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.reasoning && last.agentStreaming) {
              next[next.length - 1] = { ...last, content: last.content + msg.text };
              return next;
            }
            return [
              ...next,
              { role: 'assistant', content: msg.text, reasoning: true, agentStreaming: true },
            ];
          });
          break;
        case 'agentReasoningEnd':
          setMessages((prev) =>
            prev.map((m) =>
              m.reasoning && m.agentStreaming
                ? { ...m, agentStreaming: false, collapsed: true }
                : m,
            ),
          );
          break;
        case 'agentToolStream':
          setToolStreamChars(msg.chars);
          break;
        case 'contextUsage':
          setContextUsage({ used: msg.used, window: msg.window, source: msg.source });
          break;
        case 'compacted':
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: `Context compacted: ~${formatTokens(msg.before)} → ~${formatTokens(msg.after)} tokens`,
              note: true,
            },
          ]);
          break;
        case 'agentPlan':
          setMessages((prev) => [...prev, { role: 'assistant', content: msg.text, plan: true }]);
          break;
        case 'agentToolCall':
          setToolStreamChars(0);
          setMessages((prev) => {
            const chip = {
              role: 'assistant' as const,
              content: '',
              tool: {
                id: msg.id,
                name: msg.name,
                description: msg.description,
                done: false,
                terminalCommand: msg.terminalCommand,
              },
            };
            // Ask mode streams the answer into an empty placeholder appended at send
            // time — keep chips above it so 'chunk' still finds the placeholder last.
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && !last.content && !last.tool && !last.agentStatus) {
              return [...prev.slice(0, -1), chip, last];
            }
            return [...prev, chip];
          });
          break;
        case 'agentToolResult':
          setMessages((prev) =>
            prev.map((m) =>
              m.tool && m.tool.id === msg.id && !m.tool.done
                ? {
                    ...m,
                    tool: {
                      ...m.tool,
                      done: true,
                      ok: msg.ok,
                      summary: msg.summary,
                      label: msg.label,
                      fileEdit: msg.fileEdit,
                    },
                  }
                : m,
            ),
          );
          break;
        case 'agentStatus':
          setAgentRunning(msg.status === 'running');
          setToolStreamChars(0);
          if (msg.status !== 'running') {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.agentStatus) {
                next[next.length - 1] = {
                  ...last,
                  agentStatus: { state: msg.status, changedFiles: msg.changedFiles },
                };
                return next;
              }
              return [
                ...next,
                {
                  role: 'assistant',
                  content: '',
                  agentStatus: { state: msg.status, changedFiles: msg.changedFiles },
                },
              ];
            });
          }
          break;
      }
    };
    window.addEventListener('message', onMessage);
    postToExtension({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Auto-scroll only while the reader is already at the bottom — scrolling up
  // to read pauses following, scrolling back down resumes it.
  useEffect(() => {
    if (nearBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const slashMatches = useMemo(() => {
    if (!config || !input.startsWith('/') || input.includes(' ') || input.includes('\n')) return [];
    const term = input.slice(1).toLowerCase();
    return config.slashCommands.filter((c) => c.command.startsWith(term));
  }, [input, config]);

  const MENTIONS = [
    { name: 'file', hint: 'Active file contents' },
    { name: 'selection', hint: 'Current editor selection' },
    { name: 'problems', hint: 'Errors & warnings' },
    { name: 'terminal', hint: 'Recent terminal commands & output' },
    { name: 'workspace', hint: 'Semantic search over the codebase' },
    { name: 'folder', hint: 'Workspace file listing' },
  ];
  const mentionMatches = useMemo(() => {
    const match = /(^|\s)@(\w*)$/.exec(input);
    if (!match) return [];
    const term = match[2]!.toLowerCase();
    return MENTIONS.filter((m) => m.name.startsWith(term) && m.name !== term);
  }, [input]);

  const insertMention = (name: string) => {
    setInput((prev) => prev.replace(/(^|\s)@\w*$/, `$1@${name} `));
    inputRef.current?.focus();
  };

  const contextFiles = (): string[] | undefined => {
    const files = [
      // With an active selection, attach just those lines instead of the whole file.
      ...(includeCurrentFile && currentFile
        ? [
            currentSelection
              ? `${currentFile}#L${currentSelection.start}-${currentSelection.end}`
              : currentFile,
          ]
        : []),
      ...attached.filter((f) => f !== currentFile),
    ];
    return files.length > 0 ? files : undefined;
  };

  const send = () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || streaming || agentRunning) return;
    nearBottomRef.current = true;
    const files = contextFiles();
    const images = pendingImages.length > 0 ? pendingImages : undefined;
    setAttached([]); // attachments are per-message, like Copilot
    setPendingImages([]);
    if (editing !== null) {
      // Edited prompt: the extension truncates the conversation, restores the
      // workspace checkpoint, re-renders, and resends — no local append here.
      postToExtension({ type: 'editUserMessage', ordinal: editing, text, files, mode });
      setEditing(null);
      setInput('');
      return;
    }
    if (mode === 'agent') {
      setMessages((prev) => [...prev, { role: 'user', content: text, attachedFiles: files, images }]);
      setInput('');
      postToExtension({ type: 'agentStart', task: text, files, images });
      return;
    }
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, attachedFiles: files, images },
      { role: 'assistant', content: '' },
    ]);
    setInput('');
    setStreaming(true);
    postToExtension({ type: 'send', text, files });
  };

  const openHistory = () => {
    postToExtension({ type: 'listHistory' });
    setView('history');
  };

  const openSettings = () => {
    postToExtension({ type: 'settingsLoad' });
    setView('settings');
  };

  /**
   * Delegated clicks in the transcript: code-block action buttons, and inline
   * code references (`.hero-content`, `src/app.ts`) that open in the editor.
   */
  const onMessagesClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const button = target.closest('button[data-action]');
    if (button) {
      const code = button.closest('.codeblock')?.querySelector('pre code')?.textContent ?? '';
      if (!code) return;
      const action = button.getAttribute('data-action');
      if (action === 'copy') {
        void navigator.clipboard.writeText(code);
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1200);
      } else if (action === 'insert') {
        postToExtension({ type: 'insertCode', code });
      } else if (action === 'apply') {
        postToExtension({ type: 'applyCode', code });
      }
      return;
    }
    const inlineCode = target.closest('code');
    if (inlineCode && !inlineCode.closest('pre')) {
      const text = (inlineCode.textContent ?? '').trim();
      if (text.length >= 2 && text.length <= 120 && REFERENCE_PATTERN.test(text)) {
        postToExtension({ type: 'openReference', text });
      }
    }
  };

  const toggleTool = (index: number) => {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index && m.tool ? { ...m, tool: { ...m.tool, expanded: !m.tool.expanded } } : m,
      ),
    );
  };

  const busy = streaming || agentRunning;

  return (
    <div
      className={`app${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <header className="header">
        <span className="spacer" />
        <button
          className="ghost icon-btn"
          title={view === 'history' ? 'Back to chat' : 'History'}
          onClick={view === 'history' ? () => setView('chat') : openHistory}
        >
          {view === 'history' ? '←' : <IconHistory />}
        </button>
        <button
          className="ghost icon-btn"
          title={view === 'settings' ? 'Back to chat' : 'Settings'}
          onClick={view === 'settings' ? () => setView('chat') : openSettings}
        >
          {view === 'settings' ? '←' : <IconGear />}
        </button>
        <button
          className="ghost icon-btn"
          title="New chat"
          onClick={() => postToExtension({ type: 'newChat' })}
          disabled={busy}
        >
          <IconNew />
        </button>
      </header>

      {view === 'settings' ? (
        <SettingsView data={settingsData} />
      ) : view === 'history' ? (
        <div className="history">
          {history.length === 0 && <div className="empty">No previous conversations.</div>}
          {history.map((item) => (
            <div key={item.id} className="history-item">
              <button
                className="history-open"
                onClick={() => postToExtension({ type: 'openConversation', id: item.id })}
              >
                <span className="history-title">{item.title || 'Untitled'}</span>
                <span className="history-date">{new Date(item.updatedAt).toLocaleString()}</span>
              </button>
              <button
                className="ghost danger"
                title="Delete"
                onClick={() => postToExtension({ type: 'deleteConversation', id: item.id })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="messages" ref={scrollRef} onScroll={onScroll} onClick={onMessagesClick}>
          {messages.length === 0 && (
            <div className="empty">
              <p>Ask about your code, or switch to Agent for autonomous tasks.</p>
              <p className="hint">
                <code>/</code> for commands · <code>@selection</code> <code>@file</code>{' '}
                <code>@problems</code> <code>@workspace</code> for context · <code>+</code> to
                upload, or drag &amp; drop files/folders · paste screenshots for vision models
              </p>
            </div>
          )}
          {messages.map((m, i) => {
            if (m.tool) {
              const t = m.tool;
              if (t.fileEdit) {
                return (
                  <button
                    key={i}
                    className="file-edit-card"
                    title="Show diff"
                    onClick={() => postToExtension({ type: 'agentDiffFile', path: t.fileEdit!.path })}
                  >
                    <span className="tool-icon">✓</span>
                    <span className="tool-desc">Edited</span>
                    <span className="file-edit-name">{t.fileEdit.path}</span>
                    <span className="diff-added">+{t.fileEdit.added}</span>
                    <span className="diff-removed">−{t.fileEdit.removed}</span>
                  </button>
                );
              }
              return (
                <div key={i} className={`tool-row${t.done ? (t.ok ? ' ok' : ' fail') : ''}`}>
                  <button className="tool-chip" onClick={() => toggleTool(i)}>
                    <span className="tool-icon">{t.done ? (t.ok ? '✓' : '✗') : '⏳'}</span>
                    <span className="tool-desc">{t.description}</span>
                    {t.label && <span className="tool-label">{t.label}</span>}
                    <span className="tool-caret">{t.expanded ? '▾' : '▸'}</span>
                  </button>
                  {t.expanded && (
                    <div className="tool-detail">
                      {t.summary ? <pre>{t.summary}</pre> : <span className="menu-note">No output</span>}
                      {t.terminalCommand && (
                        <button
                          className="ghost"
                          onClick={() =>
                            postToExtension({ type: 'openInTerminal', command: t.terminalCommand! })
                          }
                        >
                          $ Run in terminal
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            }
            if (m.permission) {
              const p = m.permission;
              const decide = (choice: PermissionChoice) => {
                postToExtension({ type: 'permissionResponse', id: p.id, choice });
                setMessages((prev) =>
                  prev.map((x) =>
                    x.permission?.id === p.id
                      ? { ...x, permission: { ...x.permission, decided: choice } }
                      : x,
                  ),
                );
              };
              return (
                <div key={i} className={`permission-card${p.permission === 'destructive' ? ' destructive' : ''}`}>
                  <div className="permission-head">
                    <span className="permission-badge">{p.permission}</span>
                    Heap Code wants to:
                  </div>
                  <code className="permission-desc">{p.description}</code>
                  {p.decided ? (
                    <div className="permission-decided">
                      {p.decided === 'deny' ? '✗ Denied' : `✓ Allowed${p.decided === 'session' ? ' (session)' : p.decided === 'always' ? ' (always)' : ''}`}
                    </div>
                  ) : (
                    <div className="permission-actions">
                      <button className="primary" onClick={() => decide('allow')}>
                        Allow
                      </button>
                      {p.allowPersist && (
                        <>
                          <button className="ghost" onClick={() => decide('session')}>
                            Session
                          </button>
                          <button className="ghost" onClick={() => decide('always')}>
                            Always
                          </button>
                        </>
                      )}
                      <button className="ghost danger" onClick={() => decide('deny')}>
                        Deny
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            if (m.question) {
              const q = m.question;
              return (
                <QuestionCardView
                  key={i}
                  q={q}
                  onAnswer={(answer) => {
                    postToExtension({ type: 'agentQuestionResponse', id: q.id, answer });
                    setMessages((prev) =>
                      prev.map((x) =>
                        x.question?.id === q.id
                          ? { ...x, question: { ...x.question, answered: answer } }
                          : x,
                      ),
                    );
                  }}
                />
              );
            }
            if (m.note) {
              return (
                <div key={i} className="system-note">
                  {m.content}
                </div>
              );
            }
            if (m.reasoning) {
              return (
                <div key={i} className="reasoning-block">
                  <button
                    className="reasoning-head"
                    onClick={() =>
                      setMessages((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, collapsed: !x.collapsed } : x)),
                      )
                    }
                  >
                    💭 {m.agentStreaming ? 'Thinking…' : 'Thought'}
                    <span className="tool-caret">{m.collapsed ? '▸' : '▾'}</span>
                  </button>
                  {!m.collapsed && <div className="reasoning-body">{m.content}</div>}
                </div>
              );
            }
            if (m.plan) {
              const steps = (m.content.match(/^\s*\d+[.)]\s/gm) ?? []).length;
              return (
                <div key={i} className="plan-card">
                  <button
                    className="plan-head"
                    onClick={() =>
                      setMessages((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, collapsed: !x.collapsed } : x)),
                      )
                    }
                  >
                    <span className="plan-badge">Plan</span>
                    {steps > 0 && <span className="plan-steps">{steps} steps</span>}
                    <span className="tool-caret">{m.collapsed ? '▸' : '▾'}</span>
                  </button>
                  {!m.collapsed && (
                    <div
                      className="markdown plan-body"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                    />
                  )}
                </div>
              );
            }
            if (m.agentStatus) {
              const { state, changedFiles } = m.agentStatus;
              return (
                <div key={i} className={`agent-banner ${state === 'done' ? 'ok' : 'warn'}`}>
                  <div className="banner-head">
                    <span>
                      {state === 'done' ? '✓ ' : ''}
                      {STATUS_LABEL[state] ?? state}
                      {changedFiles.length > 0 &&
                        ` · ${changedFiles.length} file${changedFiles.length > 1 ? 's' : ''} changed`}
                    </span>
                    {changedFiles.some((f) => !f.reverted) && (
                      <button className="ghost" onClick={() => postToExtension({ type: 'agentKeepAll' })}>
                        Keep all
                      </button>
                    )}
                    {changedFiles.length > 0 && (
                      <button className="ghost" onClick={() => postToExtension({ type: 'agentRevert' })}>
                        Revert all
                      </button>
                    )}
                  </div>
                  {changedFiles.map((f) => (
                    <div key={f.path} className={`changed-file${f.reverted ? ' reverted' : ''}`}>
                      <button
                        className="file-link"
                        title="Show diff"
                        onClick={() => postToExtension({ type: 'agentDiffFile', path: f.path })}
                      >
                        {f.path}
                      </button>
                      {f.reverted ? (
                        <button
                          className="ghost"
                          title="Bring the agent's version back"
                          onClick={() => postToExtension({ type: 'agentReapplyFile', path: f.path })}
                        >
                          Reapply
                        </button>
                      ) : (
                        <>
                          <button
                            className="ghost"
                            title="Keep this file's changes"
                            onClick={() => postToExtension({ type: 'agentKeepFile', path: f.path })}
                          >
                            Keep
                          </button>
                          <button
                            className="ghost"
                            title="Restore the agent's version (if you edited or undid it manually)"
                            onClick={() => postToExtension({ type: 'agentReapplyFile', path: f.path })}
                          >
                            Reapply
                          </button>
                          <button
                            className="ghost danger"
                            title="Revert this file"
                            onClick={() => postToExtension({ type: 'agentRevertFile', path: f.path })}
                          >
                            Revert
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              );
            }
            return (
              <div key={i} className={`turn ${m.role}${m.error ? ' error' : ''}`}>
                <div className="turn-author">{m.role === 'user' ? 'You' : 'Heap Code'}</div>
                {m.role === 'assistant' ? (
                  m.content === '' && streaming && i === messages.length - 1 ? (
                    <span className="thinking">…</span>
                  ) : (
                    <div
                      className="markdown"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                    />
                  )
                ) : (
                  <>
                    <div className="user-text">{m.content}</div>
                    {m.images && m.images.length > 0 && (
                      <div className="msg-images">
                        {m.images.map((src, j) => (
                          <img key={j} src={src} alt={`attachment ${j + 1}`} />
                        ))}
                      </div>
                    )}
                    {m.attachedFiles && (
                      <div className="attach-note">📎 {m.attachedFiles.join(', ')}</div>
                    )}
                    {!busy && (
                      <>
                        <button
                          className="ghost edit-msg"
                          title="Edit this message — reverts the code and conversation to this point and resends"
                          onClick={() => {
                            const ordinal = messages.slice(0, i).filter((x) => x.role === 'user').length;
                            setEditing(ordinal);
                            setInput(m.content);
                            inputRef.current?.focus();
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="ghost edit-msg restore-msg"
                          title="Restore workspace files to the state before this message ran (conversation stays)"
                          onClick={() => {
                            const ordinal = messages.slice(0, i).filter((x) => x.role === 'user').length;
                            postToExtension({ type: 'restoreCheckpoint', ordinal });
                          }}
                        >
                          ⤺
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {agentRunning && (
            <div className="working-row">
              <span className="thinking">
                {toolStreamChars > 0
                  ? `Generating changes… ${(toolStreamChars / 1000).toFixed(1)}k chars`
                  : 'Working…'}
              </span>
            </div>
          )}
        </div>
      )}

      {view !== 'settings' && (
      <footer className="composer">
        {slashMatches.length > 0 && (
          <div className="slash-menu">
            {slashMatches.map((c) => (
              <button
                key={c.command}
                className="slash-item"
                onClick={() => {
                  setInput(`/${c.command} `);
                  inputRef.current?.focus();
                }}
              >
                <code>/{c.command}</code>
                <span>{c.title}</span>
              </button>
            ))}
          </div>
        )}
        {mentionMatches.length > 0 && (
          <div className="slash-menu">
            {mentionMatches.map((m) => (
              <button key={m.name} className="slash-item" onClick={() => insertMention(m.name)}>
                <code>@{m.name}</code>
                <span>{m.hint}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-box">
          {editing !== null && (
            <div className="editing-bar">
              ✎ Editing an earlier message — sending reverts the conversation (and any code the
              agent changed after it) to that point.
              <button
                className="ghost"
                onClick={() => {
                  setEditing(null);
                  setInput('');
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {(currentFile || attached.length > 0) && (
          <div className="context-row">
            {currentFile && (
              <button
                className={`attach-chip current${includeCurrentFile ? '' : ' off'}`}
                title={
                  includeCurrentFile
                    ? currentSelection
                      ? `Only lines ${currentSelection.start}-${currentSelection.end} of ${currentFile} go in as context — click to exclude`
                      : `${currentFile} is included as context — click to exclude`
                    : `${currentFile} excluded — click to include`
                }
                onClick={() => setIncludeCurrentFile((v) => !v)}
              >
                {currentFile.split('/').pop()}
                {currentSelection && (
                  <span className="chip-lines">
                    L{currentSelection.start}-{currentSelection.end}
                  </span>
                )}
                <span className="chip-tag">{currentSelection ? 'selection' : 'current file'}</span>
              </button>
            )}
            {attached.map((f) => (
              <span key={f} className="attach-chip" title={f.endsWith('/') ? `${f} (folder, recursive)` : f}>
                {f.endsWith('/') ? `📁 ${f.replace(/\/$/, '').split('/').pop()}/` : f.split('/').pop()}
                <button
                  className="attach-remove"
                  onClick={() => setAttached((prev) => prev.filter((x) => x !== f))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          )}
          {pendingImages.length > 0 && (
            <div className="image-row">
              {pendingImages.map((src, i) => (
                <span key={i} className="image-chip">
                  <img src={src} alt={`attachment ${i + 1}`} />
                  <button
                    className="attach-remove"
                    title="Remove image"
                    onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const items = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/'));
              if (items.length === 0) return;
              e.preventDefault();
              for (const item of items) {
                const blob = item.getAsFile();
                if (!blob) continue;
                void imageToDataUrl(blob).then((url) =>
                  setPendingImages((prev) => [...prev, url].slice(0, MAX_IMAGES)),
                );
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && editing !== null) {
                setEditing(null);
                setInput('');
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (slashMatches.length === 1 && input.trim() === `/${slashMatches[0]!.command}`) {
                  setInput(`/${slashMatches[0]!.command} `);
                  return;
                }
                send();
              }
            }}
            placeholder={
              mode === 'agent' ? 'Describe a task for the agent…' : 'Ask Heap Code…'
            }
            rows={3}
          />
          <div className="composer-footer">
            <div className="mode-picker plus-picker" ref={plusPickerRef}>
              {plusMenuOpen && (
                <div className="model-menu mode-menu">
                  <button
                    className="menu-item"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      postToExtension({ type: 'pickUpload' });
                    }}
                  >
                    Upload file
                    <span className="menu-hint"> — images &amp; files from disk</span>
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      postToExtension({ type: 'pickContextFiles' });
                    }}
                  >
                    Attach workspace files
                    <span className="menu-hint"> — pick from this project</span>
                  </button>
                </div>
              )}
              <button
                className="mode-chip plus-chip"
                title="Add files or images"
                onClick={() => setPlusMenuOpen((v) => !v)}
              >
                +
              </button>
            </div>
            <div className="mode-picker" ref={toolsPickerRef}>
              {toolsMenuOpen && (
                <div className="model-menu tools-menu">
                  <div className="tools-menu-title">
                    Agent tools ·{' '}
                    {toolGroups.reduce((n, g) => n + g.tools.filter((t) => t.enabled).length, 0)}/
                    {toolGroups.reduce((n, g) => n + g.tools.length, 0)} enabled
                  </div>
                  {toolGroups.map((g) => {
                    const allOn = g.tools.every((t) => t.enabled);
                    const someOn = g.tools.some((t) => t.enabled);
                    const collapsed = collapsedToolGroups[g.id] ?? false;
                    return (
                      <div className="tools-group" key={g.id}>
                        <button
                          className="tools-group-header"
                          onClick={() =>
                            setCollapsedToolGroups((prev) => ({ ...prev, [g.id]: !collapsed }))
                          }
                        >
                          <span className="tools-group-chevron">{collapsed ? '▸' : '▾'}</span>
                          <input
                            type="checkbox"
                            checked={allOn}
                            ref={(el) => {
                              if (el) el.indeterminate = !allOn && someOn;
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => {
                              const next = !allOn;
                              setToolGroups((prev) =>
                                prev.map((x) =>
                                  x.id === g.id
                                    ? { ...x, tools: x.tools.map((t) => ({ ...t, enabled: next })) }
                                    : x,
                                ),
                              );
                              for (const t of g.tools) {
                                postToExtension({ type: 'setToolEnabled', name: t.name, enabled: next });
                              }
                            }}
                          />
                          <span className="tools-group-label">{g.label}</span>
                          <span className="tools-group-count">
                            {g.tools.filter((t) => t.enabled).length}/{g.tools.length}
                          </span>
                        </button>
                        {!collapsed && (
                          <div className="tools-group-body">
                            {g.tools.map((t) => (
                              <label className="tool-toggle" title={t.description} key={t.name}>
                                <input
                                  type="checkbox"
                                  checked={t.enabled}
                                  onChange={() => {
                                    const next = !t.enabled;
                                    setToolGroups((prev) =>
                                      prev.map((x) =>
                                        x.id === g.id
                                          ? {
                                              ...x,
                                              tools: x.tools.map((y) =>
                                                y.name === t.name ? { ...y, enabled: next } : y,
                                              ),
                                            }
                                          : x,
                                      ),
                                    );
                                    postToExtension({ type: 'setToolEnabled', name: t.name, enabled: next });
                                  }}
                                />
                                {t.label}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {toolGroups.length === 0 && <div className="menu-note">No tools reported.</div>}
                </div>
              )}
              <button
                className="mode-chip"
                title="Choose which tools the agent may use"
                onClick={() => {
                  if (!toolsMenuOpen) postToExtension({ type: 'listTools' });
                  setToolsMenuOpen((v) => !v);
                }}
              >
                🔧
              </button>
            </div>
            <div className="mode-picker" ref={modePickerRef}>
              {modeMenuOpen && (
                <div className="model-menu mode-menu">
                  {(
                    [
                      { id: 'chat', label: 'Ask', hint: 'Chat about your code' },
                      { id: 'agent', label: 'Agent', hint: 'Autonomously edit files & run commands' },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.id}
                      className={`menu-item${mode === option.id ? ' active' : ''}`}
                      onClick={() => {
                        setMode(option.id);
                        setModeMenuOpen(false);
                      }}
                    >
                      {mode === option.id ? '✓ ' : ''}
                      {option.label}
                      <span className="menu-hint"> — {option.hint}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                className="mode-chip"
                disabled={busy}
                title="Mode"
                onClick={() => setModeMenuOpen((v) => !v)}
              >
                {mode === 'agent' ? 'Agent' : 'Ask'} ▾
              </button>
            </div>
            <div className="model-picker" ref={modelPickerRef}>
              {modelMenu && (
                <div className="model-menu">
                  <div className="menu-section">Provider</div>
                  {modelMenu.profiles.map((p) => (
                    <button
                      key={p.name}
                      className={`menu-item${p.active ? ' active' : ''}`}
                      onClick={() => {
                        postToExtension({ type: 'setProfile', name: p.name });
                        setModelMenu({ loading: true, profiles: [], models: [] });
                        postToExtension({ type: 'listModels' });
                      }}
                    >
                      {p.active ? '✓ ' : ''}
                      {p.name}
                    </button>
                  ))}
                  <button
                    className="menu-item"
                    onClick={() => {
                      setModelMenu(null);
                      postToExtension({ type: 'runCommand', command: 'addProfile' });
                    }}
                  >
                    ＋ Add provider…
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      setModelMenu(null);
                      postToExtension({ type: 'runCommand', command: 'setApiKey' });
                    }}
                  >
                    🔑 Set API key…
                  </button>
                  <div className="menu-section">Model</div>
                  {modelMenu.loading && <div className="menu-note">Loading…</div>}
                  {!modelMenu.loading && modelMenu.models.length === 0 && (
                    <div className="menu-note">Could not list models</div>
                  )}
                  {modelMenu.models.map((id) => (
                    <button
                      key={id}
                      className={`menu-item${id === config?.model ? ' active' : ''}`}
                      onClick={() => {
                        postToExtension({ type: 'setModel', model: id });
                        setModelMenu(null);
                      }}
                    >
                      {id === config?.model ? '✓ ' : ''}
                      {id}
                    </button>
                  ))}
                  <div className="menu-section" />
                  <button
                    className="menu-item"
                    onClick={() => {
                      setModelMenu(null);
                      postToExtension({ type: 'runCommand', command: 'selectModel' });
                    }}
                  >
                    Model roles (edit/apply/autocomplete…) →
                  </button>
                </div>
              )}
              <button
                className="model-chip"
                title="Provider & model"
                onClick={() => {
                  if (modelMenu) {
                    setModelMenu(null);
                  } else {
                    setModelMenu({ loading: true, profiles: [], models: [] });
                    postToExtension({ type: 'listModels' });
                  }
                }}
              >
                {config ? `${config.profile} · ${config.model || 'no model'}` : '…'} ▾
              </button>
            </div>
            <span className="spacer" />
            {contextUsage && (
              <ContextMeter
                used={contextUsage.used}
                window={contextUsage.window}
                source={contextUsage.source}
                onOpenSettings={openSettings}
              />
            )}
            {busy ? (
              <button
                className="primary send"
                onClick={() =>
                  postToExtension(agentRunning ? { type: 'agentStop' } : { type: 'stop' })
                }
              >
                ◼ Stop
              </button>
            ) : (
              <button
                className="primary send"
                onClick={send}
                disabled={!input.trim() && pendingImages.length === 0}
              >
                ➤
              </button>
            )}
          </div>
        </div>
      </footer>
      )}
    </div>
  );
}
