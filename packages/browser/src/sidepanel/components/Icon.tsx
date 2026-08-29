import type { ToolIcon } from '../../shared/toolLabels.js';

/**
 * The icon set, drawn rather than loaded.
 *
 * Every glyph is one path on a 16 grid, stroked in `currentColor`, so an icon
 * inherits the colour and the disabled state of whatever it sits in and nothing
 * has to be recoloured for dark mode. No font, no sprite sheet, no network:
 * an MV3 bundle may not fetch anything at runtime, and an icon font would be a
 * second copy of the type system for the sake of twenty shapes.
 *
 * Stroke width is 1.5 at 16px, which is the weight that survives the panel's
 * 12px context without turning into a smudge.
 */

export type IconName =
  | ToolIcon
  | 'brand'
  | 'tasks'
  | 'log'
  | 'settings'
  | 'newChat'
  | 'send'
  | 'stop'
  | 'chevron'
  | 'close'
  | 'shield'
  | 'check'
  | 'lock'
  | 'plug'
  | 'sparkle'
  | 'arrowLeft';

const PATHS: Record<IconName, string> = {
  // Tools
  read: 'M3 3.5h10v9H3zM5.5 6h5M5.5 8.5h5M5.5 11h3',
  find: 'M7.25 3a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5ZM10.5 10.5 13.5 13.5',
  table: 'M2.5 4h11v8h-11zM2.5 7h11M6.5 4v8',
  camera: 'M2.5 5.5h2.5l1-1.5h4l1 1.5h2.5v7h-11zM8 10.75a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z',
  scroll: 'M8 2.5v11M8 13.5 4.5 10M8 13.5 11.5 10',
  wait: 'M8 2.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5ZM8 5.5V8l1.75 1.25',
  tabs: 'M2.5 5.5h5v8h-5zM9 2.5h4.5v11H9z',
  pointer: 'M4 2.5 12 8l-3.5.75L10 12.5l-1.5.75L7 9.5l-3 2.25z',
  keyboard: 'M2 4.5h12v7H2zM4.5 7h.01M7 7h.01M9.5 7h.01M11.5 7h.01M5 9.5h6',
  form: 'M3 3.5h10v9H3zM5.5 6.5h5M5.5 9.5h3',
  navigate: 'M3 8h9M8.5 4.5 12 8l-3.5 3.5',
  back: 'M13 8H4M7.5 4.5 4 8l3.5 3.5',
  download: 'M8 2.5v7M5 7l3 3 3-3M3 12.5h10',
  attach: 'M11 5.5 6.25 10.25a1.75 1.75 0 0 0 2.5 2.5L13 8.5a3.5 3.5 0 0 0-5-5L3.75 7.75',
  drag: 'M5 3.5h.01M5 8h.01M5 12.5h.01M11 3.5h.01M11 8h.01M11 12.5h.01',
  ask: 'M6 6a2 2 0 1 1 2.75 1.85c-.5.2-.75.6-.75 1.15v.5M8 12h.01M8 2.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5Z',
  done: 'M3.5 8.5 6.5 11.5 12.5 5',
  tool: 'M8 2.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5ZM8 5.75v4.5',

  // Chrome
  brand: 'M8 2 13 5v6l-5 3-5-3V5z',
  tasks: 'M4 2.5h8v11l-4-2.5-4 2.5z',
  log: 'M3 4h10M3 8h10M3 12h6',
  settings: 'M3 4.5h10M3 8h10M3 11.5h10M6 3v3M10.5 6.5v3M5 10v3',
  newChat: 'M8 3.5v9M3.5 8h9',
  send: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7',
  stop: 'M4.75 4.75h6.5v6.5h-6.5z',
  chevron: 'M4.5 6.25 8 9.75l3.5-3.5',
  close: 'M4 4l8 8M12 4l-8 8',
  shield: 'M8 2.25 13 4.25v4c0 2.6-2 4.6-5 5.5-3-.9-5-2.9-5-5.5v-4z',
  check: 'M3.5 8.5 6.5 11.5 12.5 5',
  lock: 'M4 7.25h8v6H4zM5.75 7.25V5.5a2.25 2.25 0 0 1 4.5 0v1.75',
  plug: 'M6 2.5v4M10 2.5v4M4 6.5h8v2a4 4 0 0 1-4 4 4 4 0 0 1-4-4z',
  sparkle: 'M8 2.5 9.4 6.6 13.5 8 9.4 9.4 8 13.5 6.6 9.4 2.5 8 6.6 6.6z',
  arrowLeft: 'M12.5 8h-9M7 3.5 3.5 8 7 12.5',
};

export function Icon({
  name,
  size = 14,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
