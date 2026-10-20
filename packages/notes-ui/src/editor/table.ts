import { EditorView, WidgetType } from '@codemirror/view';
import { renderMarkdown } from '@heapcode/web-ui/markdown';
import { noteContext } from './live.js';

/**
 * A Markdown table you edit as a table, as Bear lets you: click a cell to
 * type in it, Tab and Enter to move, links open on a click. The Markdown is
 * rewritten from the table on each change, so it stays a plain GFM table in
 * the file. Arrowing the cursor into it (or "Edit as Markdown") still gives
 * the raw text, for anything the table view can't do.
 */

export type Align = 'left' | 'center' | 'right' | '';

export interface TableModel {
  /** Header first; each cell its raw Markdown. */
  rows: string[][];
  aligns: Align[];
}

/** `| a | b |` → [' a ', ' b '], leading and trailing pipes optional, `\|` kept. */
export function splitRow(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/);
}

export function parseTable(source: string): TableModel {
  const lines = source.split('\n').filter((l) => l.trim() !== '');
  const delimiter = lines[1] ?? '';
  const aligns = splitRow(delimiter).map((cell): Align => {
    const t = cell.trim();
    const l = t.startsWith(':');
    const r = t.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const rows = [lines[0] ?? '', ...lines.slice(2)].map((l) => splitRow(l).map((c) => c.trim()));
  const width = Math.max(aligns.length, ...rows.map((r) => r.length), 1);
  return {
    rows: rows.map((r) => [...r, ...Array<string>(width - r.length).fill('')]),
    aligns: [...aligns, ...Array<Align>(Math.max(0, width - aligns.length)).fill('')].slice(
      0,
      width,
    ),
  };
}

/** One line per row; a cell's own pipes escaped and line breaks folded, so the table holds. */
export function serializeTable(t: TableModel): string {
  const cell = (s: string) =>
    s
      .replace(/\r?\n/g, ' ')
      .replace(/(?<!\\)\|/g, '\\|')
      .trim();
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  const rule = (a: Align) =>
    a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
  const [head = [], ...body] = t.rows;
  return [line(head), `| ${t.aligns.map(rule).join(' | ')} |`, ...body.map(line)].join('\n');
}

const copy = (t: TableModel): TableModel => ({
  rows: t.rows.map((r) => [...r]),
  aligns: [...t.aligns],
});

export const tableOps = {
  setCell(t: TableModel, row: number, col: number, text: string): TableModel {
    const n = copy(t);
    n.rows[row]![col] = text;
    return n;
  },
  insertRow(t: TableModel, at: number): TableModel {
    const n = copy(t);
    // Never above the header: a new first body row at most.
    n.rows.splice(Math.max(1, at), 0, Array<string>(t.aligns.length).fill(''));
    return n;
  },
  deleteRow(t: TableModel, row: number): TableModel {
    if (row === 0) return t;
    const n = copy(t);
    n.rows.splice(row, 1);
    return n;
  },
  insertColumn(t: TableModel, at: number): TableModel {
    const n = copy(t);
    for (const r of n.rows) r.splice(at, 0, '');
    n.aligns.splice(at, 0, '');
    return n;
  },
  deleteColumn(t: TableModel, col: number): TableModel {
    if (t.aligns.length <= 1) return t;
    const n = copy(t);
    for (const r of n.rows) r.splice(col, 1);
    n.aligns.splice(col, 1);
    return n;
  },
};

/** After a change redraws the table, which cell to carry on editing. */
let resume: { from: number; row: number; col: number } | undefined;

function cellHtml(raw: string): string {
  if (!raw.trim()) return '';
  const html = renderMarkdown(raw, { highlight: false, wikiLinks: true }).trim();
  return html.replace(/^<p>([\s\S]*)<\/p>$/, '$1');
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(o: TableWidget): boolean {
    return o.source === this.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const model = parseTable(this.source);
    const wrap = document.createElement('div');
    wrap.className = 'cm-table';
    const table = wrap.appendChild(document.createElement('table'));
    const cells: HTMLElement[][] = [];
    const readOnly = () => view.state.readOnly;

    model.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      cells.push([]);
      row.forEach((raw, c) => {
        const cell = tr.appendChild(document.createElement(r === 0 ? 'th' : 'td'));
        const align = model.aligns[c];
        if (align) cell.style.textAlign = align;
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        this.show(cell, raw);
        cells[r]!.push(cell);
      });
      if (r === 0) table.appendChild(document.createElement('thead')).appendChild(tr);
      else (table.tBodies[0] ?? table.appendChild(document.createElement('tbody'))).appendChild(tr);
    });

    // ── Where the table is now, and writing it back ──
    const here = (): number | undefined => {
      const from = view.posAtDOM(wrap);
      return view.state.sliceDoc(from, from + this.source.length) === this.source
        ? from
        : undefined;
    };
    const write = (next: TableModel, then?: { row: number; col: number }) => {
      const from = here();
      if (from === undefined) return;
      const insert = serializeTable(next);
      if (insert === this.source) {
        if (then) edit(then.row, then.col);
        return;
      }
      resume = then && { from, ...then };
      view.dispatch({
        changes: { from, to: from + this.source.length, insert },
        userEvent: 'input.table',
      });
    };

    // ── Editing one cell ──
    let editing: { row: number; col: number; input: HTMLInputElement } | undefined;
    const close = (save: boolean, then?: { row: number; col: number }) => {
      if (!editing) return;
      const { row, col, input } = editing;
      editing = undefined;
      const value = input.value;
      if (save && value !== model.rows[row]![col]) {
        write(tableOps.setCell(model, row, col, value), then);
        return;
      }
      this.show(cells[row]![col]!, model.rows[row]![col]!);
      if (then) edit(then.row, then.col);
    };
    const edit = (row: number, col: number) => {
      if (readOnly()) return;
      if (row >= model.rows.length) {
        // Tab past the last cell: a new row, as in Bear.
        write(tableOps.insertRow(model, model.rows.length), { row, col: 0 });
        return;
      }
      const cell = cells[row]?.[col];
      if (!cell) return;
      if (editing) close(true);
      const input = document.createElement('input');
      input.className = 'cm-cell-input';
      input.value = model.rows[row]![col]!;
      input.setAttribute('aria-label', `Row ${row + 1}, column ${col + 1}`);
      cell.replaceChildren(input);
      editing = { row, col, input };
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const width = model.aligns.length;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(false);
        else if (e.key === 'Enter') {
          const below = row + 1 < model.rows.length ? { row: row + 1, col } : undefined;
          close(true, below);
          if (!below) view.focus();
        } else if (e.key === 'Tab') {
          const i = row * width + col + (e.shiftKey ? -1 : 1);
          if (i < 0) close(true);
          else close(true, { row: Math.floor(i / width), col: i % width });
        } else return;
        e.preventDefault();
        e.stopPropagation();
      });
      input.addEventListener('blur', () => editing?.input === input && close(true));
    };

    // ── Pointer: links open, anything else in a cell edits it ──
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.cm-cell-input')) return;
      e.preventDefault();
      if (target.closest('a')) return;
      if (target.closest('.cm-table-add'))
        return write(tableOps.insertRow(model, model.rows.length), {
          row: model.rows.length,
          col: 0,
        });
      const cell = target.closest<HTMLElement>('th, td');
      if (cell) edit(Number(cell.dataset.row), Number(cell.dataset.col));
    });
    wrap.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const ctx = view.state.facet(noteContext);
      if (a.dataset.wikilink !== undefined) ctx.openLink(a.dataset.wikilink);
      else if (a.getAttribute('href')) ctx.openUrl(a.getAttribute('href')!);
    });

    // ── Right-click: rows, columns, the raw Markdown ──
    wrap.addEventListener('contextmenu', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('th, td');
      if (!cell || readOnly()) return;
      e.preventDefault();
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      popMenu(e.clientX, e.clientY, [
        { label: 'Edit cell', run: () => edit(row, col) },
        'separator',
        {
          label: 'Insert row above',
          run: () => write(tableOps.insertRow(model, row)),
          disabled: row === 0,
        },
        { label: 'Insert row below', run: () => write(tableOps.insertRow(model, row + 1)) },
        { label: 'Insert column left', run: () => write(tableOps.insertColumn(model, col)) },
        { label: 'Insert column right', run: () => write(tableOps.insertColumn(model, col + 1)) },
        'separator',
        {
          label: 'Delete row',
          run: () => write(tableOps.deleteRow(model, row)),
          disabled: row === 0,
          danger: true,
        },
        {
          label: 'Delete column',
          run: () => write(tableOps.deleteColumn(model, col)),
          disabled: model.aligns.length <= 1,
          danger: true,
        },
        'separator',
        {
          label: 'Edit as Markdown',
          run: () => {
            const from = here();
            if (from === undefined) return;
            view.dispatch({ selection: { anchor: from + 2 } });
            view.focus();
          },
        },
      ]);
    });

    if (!readOnly()) {
      const add = wrap.appendChild(document.createElement('button'));
      add.type = 'button';
      add.className = 'cm-table-add';
      add.textContent = '+ Row';
      add.title = 'Add a row (or Tab from the last cell)';
    }

    // Carry on in the cell a Tab or Enter moved to, once this redraw is in.
    if (resume) {
      const want = resume;
      requestAnimationFrame(() => {
        if (resume !== want) return;
        resume = undefined;
        if (view.posAtDOM(wrap) === want.from) edit(want.row, want.col);
      });
    }
    return wrap;
  }

  /** A cell as read: rendered Markdown, with a pencil when its links take the click. */
  private show(cell: HTMLElement, raw: string): void {
    cell.innerHTML = cellHtml(raw) || '&nbsp;';
    if (cell.querySelector('a')) {
      const pen = cell.appendChild(document.createElement('span'));
      pen.className = 'cm-cell-pen';
      pen.textContent = '✎';
      pen.title = 'Edit this cell';
    }
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** A menu from inside the editor, styled as the app's (menu.tsx's classes). */
type Entry = 'separator' | { label: string; run(): void; disabled?: boolean; danger?: boolean };

function popMenu(x: number, y: number, items: Entry[]): void {
  document.querySelector('.ctx-menu.cm-owned')?.remove();
  const menu = document.body.appendChild(document.createElement('div'));
  menu.className = 'ctx-menu cm-owned';
  menu.setAttribute('role', 'menu');
  const done = () => {
    menu.remove();
    window.removeEventListener('mousedown', away, true);
    window.removeEventListener('keydown', key, true);
  };
  const away = (e: Event) => !menu.contains(e.target as Node) && done();
  const key = (e: KeyboardEvent) => e.key === 'Escape' && done();
  for (const item of items) {
    if (item === 'separator') {
      menu.appendChild(document.createElement('div')).className = 'ctx-sep';
      continue;
    }
    const b = menu.appendChild(document.createElement('button'));
    b.className = `ctx-item${item.danger ? ' ctx-danger' : ''}`;
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    b.disabled = !!item.disabled;
    b.addEventListener('mouseenter', () => b.classList.add('ctx-active'));
    b.addEventListener('mouseleave', () => b.classList.remove('ctx-active'));
    b.addEventListener('click', () => {
      done();
      item.run();
    });
  }
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, x + width > innerWidth - 6 ? x - width : x)}px`;
  menu.style.top = `${Math.max(6, y + height > innerHeight - 6 ? y - height : y)}px`;
  window.addEventListener('mousedown', away, true);
  window.addEventListener('keydown', key, true);
}
