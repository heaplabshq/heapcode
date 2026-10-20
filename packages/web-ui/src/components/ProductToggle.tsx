import { useState } from 'react';
import { useMenu } from './useMenu.js';

export type Product = 'code' | 'chat' | 'qa' | 'notes';

/**
 * Switching between Heap Code, Heap Chat, Heapnotes and Heap QA.
 *
 * The product's own name in the rail's top row, with a chevron: click it and
 * a menu lists every product served here, each with a line saying what it is
 * for. It replaced four 19px unlabelled icons squeezed in beside the name,
 * which cut the name to "Heap Co…" and asked people to learn four glyphs to
 * find out the other products existed.
 *
 * It is a real navigation — the products are different sessions with
 * different tool rosters — served from one origin under one token
 * (`WebHostOptions.mount`). A link to another port would arrive without the
 * HttpOnly cookie and bounce to 401.
 *
 * Which products are here is read off `<html>`, the same way on every page,
 * so no product can forget to list one. With only the current product served
 * it is the plain name: a menu with one entry teaches people the control does
 * nothing.
 */
export function ProductToggle({ current }: { current: Product }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { root, button, onMenuKey } = useMenu(open, setOpen);
  const here = availableProducts(current);
  const me = PRODUCTS.find((p) => p.id === current)!;

  if (here.length < 2) return <span className="rail-brand">{me.name}</span>;

  return (
    <div className="product-switch" ref={root}>
      <button
        ref={button}
        className="product-switch-btn"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch product"
      >
        <span className="rail-brand">{me.name}</span>
        <IconChevron />
      </button>
      {open && (
        <div className="tool-menu product-menu" role="menu" aria-label="Products" onKeyDown={onMenuKey}>
          {here.map((p) => (
            <a
              key={p.id}
              role="menuitem"
              href={p.path}
              className={`tool-menu-item ${p.id === current ? 'tool-menu-item-on' : ''}`}
              aria-current={p.id === current ? 'page' : undefined}
              onClick={(e) => {
                // Already here: close rather than reload the page under the user.
                if (p.id === current) {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
            >
              <span className="tool-menu-icon">{p.icon}</span>
              <span className="tool-menu-text">
                <span className="tool-menu-label">{p.name}</span>
                <span className="tool-menu-sub">{p.blurb}</span>
              </span>
              {p.id === current && <IconCheck />}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Every product, in the order the menu lists them. */
const PRODUCTS: { id: Product; name: string; blurb: string; path: string; icon: JSX.Element }[] = [
  { id: 'code', name: 'Heap Code', blurb: 'Change and fix code in a folder', path: '/', icon: <IconCode /> },
  { id: 'chat', name: 'Heap Chat', blurb: 'Ask about your documents and files', path: '/chat/', icon: <IconChat /> },
  { id: 'notes', name: 'Heapnotes', blurb: 'Write and find your notes', path: '/notes/', icon: <IconNotes /> },
  { id: 'qa', name: 'Heap QA', blurb: 'Record and run tests of your app', path: '/qa/', icon: <IconQa /> },
];

/**
 * The products reachable from this page. Heap Code is the root: it is here
 * when this page is Heap Code, or when the host says this page is mounted
 * beside it. The others are here when the host lists them.
 */
function availableProducts(current: Product): typeof PRODUCTS {
  const served = servedProducts();
  const codeHere = current === 'code' || document.documentElement.dataset.sibling === 'code';
  // Without Heap Code at the root there is no shared origin to switch on.
  if (!codeHere) return PRODUCTS.filter((p) => p.id === current);
  return PRODUCTS.filter((p) => p.id === current || p.id === 'code' || served.includes(p.id));
}

/** The products served beside this page, as the host stamps them on `<html>`: `chat,qa`. */
export function servedProducts(): string[] {
  return (document.documentElement.dataset.products ?? '').split(',').filter(Boolean);
}

function IconChevron(): JSX.Element {
  return (
    <svg className="product-switch-chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck(): JSX.Element {
  return (
    <svg className="product-menu-check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconNotes(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M4 2.5h5.5L12.5 5.5v8H4z" strokeLinejoin="round" />
      <path d="M6 8h4.5M6 10.5h3" strokeLinecap="round" />
    </svg>
  );
}

function IconQa(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3 3.5h6.5M3 7h4M3 10.5h3" strokeLinecap="round" />
      <path d="m8.5 10.5 2 2 3.5-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChat(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 6.2a3 3 0 0 1 3-3h3.2a3 3 0 0 1 0 6H6l-2.4 2v-2a3 3 0 0 1-1.1-2.3z" strokeLinejoin="round" />
      <path d="M11 7.4a3 3 0 0 1 2.5 3v2.4L11.4 11H9.2" strokeLinejoin="round" />
    </svg>
  );
}

function IconCode(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M5.8 4.5 2.5 8l3.3 3.5M10.2 4.5 13.5 8l-3.3 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
