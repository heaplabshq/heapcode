/**
 * One name per tool, in the two tenses the product needs.
 *
 * The transcript reports what already happened ("Read the page"); the bar on
 * the page reports what is happening right now ("Reading the page"). Those were
 * two separate lists in two files, which is how `attach_file` ended up named in
 * neither and rendered to the user as `attach_file`.
 *
 * The icon key travels with them because it answers the same question -- what
 * kind of thing is this -- and a tool added without one should be obvious at
 * the point it is added, not discovered later as a blank square.
 */

export type ToolIcon =
  | 'read'
  | 'find'
  | 'table'
  | 'camera'
  | 'scroll'
  | 'wait'
  | 'tabs'
  | 'pointer'
  | 'keyboard'
  | 'form'
  | 'navigate'
  | 'back'
  | 'download'
  | 'attach'
  | 'drag'
  | 'ask'
  | 'done'
  | 'tool';

export interface ToolLabel {
  /** For the transcript, after the fact. */
  past: string;
  /** For the bar on the page, while it is happening. */
  present: string;
  icon: ToolIcon;
}

const TOOLS: Record<string, ToolLabel> = {
  read_page: { past: 'Read the page', present: 'Reading the page', icon: 'read' },
  get_page_text: { past: 'Read the text', present: 'Reading the text', icon: 'read' },
  get_elements: { past: 'Looked for controls', present: 'Looking for controls', icon: 'find' },
  extract_data: { past: 'Extracted table data', present: 'Collecting rows', icon: 'table' },
  screenshot: { past: 'Took a picture', present: 'Taking a picture', icon: 'camera' },
  scroll: { past: 'Scrolled', present: 'Scrolling', icon: 'scroll' },
  wait: { past: 'Waited for the page', present: 'Waiting for the page', icon: 'wait' },
  hover: { past: 'Hovered', present: 'Hovering', icon: 'pointer' },
  list_tabs: { past: 'Listed the tabs', present: 'Listing the tabs', icon: 'tabs' },
  switch_tab: { past: 'Switched tab', present: 'Switching tab', icon: 'tabs' },
  open_tab: { past: 'Opened a tab', present: 'Opening a tab', icon: 'tabs' },
  close_tab: { past: 'Closed a tab', present: 'Closing a tab', icon: 'tabs' },
  click: { past: 'Clicked', present: 'Clicking', icon: 'pointer' },
  type: { past: 'Typed', present: 'Typing', icon: 'keyboard' },
  select: { past: 'Chose an option', present: 'Choosing an option', icon: 'form' },
  press_key: { past: 'Pressed a key', present: 'Pressing a key', icon: 'keyboard' },
  fill_form: { past: 'Filled in the form', present: 'Filling in the form', icon: 'form' },
  autofill_form: { past: 'Filled in your details', present: 'Filling in your details', icon: 'form' },
  navigate: { past: 'Went to a page', present: 'Going to a page', icon: 'navigate' },
  go_back: { past: 'Went back', present: 'Going back', icon: 'back' },
  next_page: { past: 'Turned the page', present: 'Turning the page', icon: 'navigate' },
  drag: { past: 'Dragged', present: 'Dragging', icon: 'drag' },
  download: { past: 'Saved a file', present: 'Saving a file', icon: 'download' },
  attach_file: { past: 'Attached a file', present: 'Attaching a file', icon: 'attach' },
  ask_user: { past: 'Asked you', present: 'Waiting for your answer', icon: 'ask' },
  hand_over: { past: 'Handed over to you', present: 'Waiting for you to do it', icon: 'pointer' },
  finish: { past: 'Finished', present: 'Finishing', icon: 'done' },
};

/**
 * The tool, named for a person.
 *
 * An unknown name falls back to itself rather than to "working": a tool this
 * file has not caught up with should read as a gap, not as an anonymous step.
 */
export function toolLabel(name: string): ToolLabel {
  return (
    TOOLS[name] ?? {
      past: name.replace(/_/g, ' '),
      present: name.replace(/_/g, ' '),
      icon: 'tool',
    }
  );
}
