export type Product = 'code' | 'chat' | 'qa' | 'notes';

/**
 * Switching between Heap Code, Heap Chat, Heapnotes and Heap QA.
 *
 * A row of icon tabs beside the product's name at the top of the rail, the
 * way the Claude app switches between chat and code: every product in sight,
 * so nobody has to open anything to find out the others exist. (A
 * name-and-chevron menu was tried and hid them.) Each tab's tooltip says
 * what that product is for.
 *
 * It is a real navigation — the products are different sessions with
 * different tool rosters — served from one origin under one token
 * (`WebHostOptions.mount`). A link to another port would arrive without the
 * HttpOnly cookie and bounce to 401.
 *
 * Which products are here is read off `<html>`, the same way on every page,
 * so no product can forget to list one, and the order is the same
 * everywhere. With only the current product served it renders nothing: a
 * switcher with one working half teaches people the control is broken.
 */
export function ProductToggle({ current }: { current: Product }): JSX.Element | null {
  const here = availableProducts(current);
  if (here.length < 2) return null;
  return (
    <div className="product-toggle" role="group" aria-label="Product">
      {here.map((p) => (
        <a
          key={p.id}
          className={p.id === current ? 'product-tab product-tab-on' : 'product-tab'}
          href={p.path}
          aria-current={p.id === current ? 'page' : undefined}
          title={`${p.name} — ${p.blurb}`}
        >
          {p.icon}
          <span className="sr-only">{p.name}</span>
        </a>
      ))}
    </div>
  );
}

/** The product's display name, for the rail's brand. */
export function productName(product: Product): string {
  return PRODUCTS.find((p) => p.id === product)!.name;
}

/** Every product, in the order the switcher shows them. */
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
