/**
 * The chat pane's top-right control strip.
 *
 * One button, for the workspace panel. It used to be a "Changes" item in the
 * left rail, which was the wrong place twice over: the rail is for navigating
 * between conversations and settings, whereas the panel is a view *of* the
 * conversation's workspace — and the panel already carries its own tabs, so a
 * rail entry named after one of them ("Changes") could only ever open that one
 * tab while pretending to be the whole panel. Files and Terminal had the same
 * problem and are simply the panel's other tabs now.
 *
 * Top-right because that is where a view toggle belongs relative to the view
 * it toggles, and because it is the one corner the reading column never
 * reaches.
 */
export interface ChatToolsProps {
  panelOpen: boolean;
  onTogglePanel(): void;
  /** Changed files this session, shown as a badge so the panel need not be open. */
  changeCount: number;
}

export function ChatTools({ panelOpen, onTogglePanel, changeCount }: ChatToolsProps): JSX.Element {
  return (
    <div className="chat-tools">
      <button
        className={`chat-tool ${panelOpen ? 'chat-tool-on' : ''}`}
        onClick={onTogglePanel}
        aria-pressed={panelOpen}
        title={panelOpen ? 'Hide the workspace panel' : 'Show the workspace panel'}
      >
        <IconPanel />
        <span>Workspace</span>
        {changeCount > 0 && <span className="chat-tool-badge">{changeCount}</span>}
      </button>
    </div>
  );
}

/** A panel hinged on the right — the thing the button actually opens. */
function IconPanel(): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}
