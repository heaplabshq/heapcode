import type { CdpSession } from './cdp.js';
import { namesSensitiveField } from '../shared/sensitive.js';
import { isPaymentField, moneySegmentOf, namedForMoney, submitsForm } from '../shared/moneyRules.js';

/**
 * The things the accessibility tree does not know.
 *
 * The AX tree is better than the DOM walk at everything it covers -- computed
 * roles, real accessible names, what is genuinely hidden. But it is an
 * *accessibility* tree, and three of our safety signals are not accessibility
 * concepts at all:
 *
 *   - `sensitive` -- there is no AX property for "this is a password field".
 *   - `submits`   -- "inside a form, and submits it" is markup, not semantics.
 *   - `checkout`  -- class names, form actions and card fields nearby.
 *
 * So the CDP driver was building controls with all three unset, and every
 * guardrail that reads them was silently inert on the default driver: the
 * refusal to type into credential fields, the form-submit escalation, and the
 * payment-landmark escalation. Not one of them was failing loudly. They were
 * returning `write` on a checkout button and nobody was being asked.
 *
 * `DOMSnapshot.captureSnapshot` closes it in one round trip. It returns every
 * node in the tab flat -- parent index, tag, attributes, backend node id --
 * string-table encoded, which is why it is used here rather than
 * `DOM.getDocument`: same information, a fraction of the payload, and the
 * backend node id is exactly the key our handles already point at.
 *
 * The rules are not reimplemented here. `shared/moneyRules.ts` and
 * `shared/sensitive.ts` hold them, and this is the second walk over them.
 */

/** What one element tells us that its accessible name does not. */
export interface ControlFacts {
  sensitive?: boolean;
  submits?: boolean;
  checkout?: string;
  autocomplete?: string;
  href?: string;
}

export interface PageFacts {
  /** Facts for the node behind a handle, or undefined if it has none worth carrying. */
  for(backendNodeId: number): ControlFacts | undefined;
  /**
   * Whether this node was in the snapshot at all.
   *
   * The distinction `for()` cannot make on its own, and it is the one that
   * matters: a button with no entry might be an ordinary button with nothing
   * notable about it, or it might be a checkout button in an out-of-process
   * iframe that `captureSnapshot` never reached. The first is safe to classify
   * on its name; the second is not, and reading it as the first is the exact
   * mistake this whole module exists to stop making.
   */
  knows(backendNodeId: number): boolean;
}

interface NodeTreeSnapshot {
  parentIndex?: number[];
  nodeType?: number[];
  nodeName?: number[];
  backendNodeId?: number[];
  attributes?: number[][];
}

interface CaptureSnapshotResult {
  documents?: { nodes?: NodeTreeSnapshot }[];
  strings?: string[];
}

const ELEMENT_NODE = 1;

/**
 * Read the tab's markup once, and answer questions about it.
 *
 * Returns `undefined` when the snapshot could not be taken at all -- the caller
 * treats that as "this driver could not compute the signals" and fails closed,
 * rather than carrying on with three guardrails quietly switched off, which is
 * the state this whole module exists to end.
 */
export async function pageFacts(session: CdpSession): Promise<PageFacts | undefined> {
  let result: CaptureSnapshotResult;
  try {
    result = await session.send<CaptureSnapshotResult>('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
    });
  } catch {
    return undefined;
  }

  const strings = result.strings ?? [];
  const text = (index: number | undefined): string =>
    index === undefined || index < 0 ? '' : (strings[index] ?? '');

  const facts = new Map<number, ControlFacts>();
  /** Every element the snapshot reached, entry or not. */
  const seen = new Set<number>();

  for (const document of result.documents ?? []) {
    const nodes = document.nodes;
    if (!nodes?.nodeName || !nodes.backendNodeId) continue;

    const names = nodes.nodeName;
    const backendIds = nodes.backendNodeId;
    const count = names.length;
    const parent = nodes.parentIndex ?? [];
    const types = nodes.nodeType ?? [];
    const attributes = nodes.attributes ?? [];

    const tagOf = (index: number): string => text(names[index]).toUpperCase();

    /** `class` and friends for one node, as the rules want to read them. */
    const attrsOf = (index: number): ((attribute: string) => string | undefined) => {
      const flat = attributes[index] ?? [];
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < flat.length; i += 2) {
        map.set(text(flat[i]).toLowerCase(), text(flat[i + 1]));
      }
      return (attribute) => map.get(attribute.toLowerCase());
    };

    /** A form's money-ish destination, if it has one. */
    const formMoney = (index: number): string | undefined => {
      if (tagOf(index) !== 'FORM') return undefined;
      const segment = moneySegmentOf(attrsOf(index)('action'));
      return segment ? `the form posts to /${segment}` : undefined;
    };

    // Which containers actually take payment. `takesPayment` in the DOM walk
    // asks this with `querySelector`; here the same question is answered by
    // marking each card field's ancestors on the way up, which is the same
    // relation read from the other end.
    const containsPayment = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      if (types[index] !== ELEMENT_NODE) continue;
      const tag = tagOf(index);
      const takes = isPaymentField(tag, attrsOf(index)) || formMoney(index) !== undefined;
      if (!takes) continue;
      for (let node = index; node >= 0; node = parent[node] ?? -1) {
        if (containsPayment[node]) break;
        containsPayment[node] = 1;
      }
    }

    for (let index = 0; index < count; index++) {
      if (types[index] !== ELEMENT_NODE) continue;
      const backendNodeId = backendIds[index];
      if (backendNodeId === undefined) continue;

      seen.add(backendNodeId);

      const tag = tagOf(index);
      const get = attrsOf(index);
      const entry: ControlFacts = {};

      // A password field is sensitive whatever it is called; everything else is
      // judged on what it is called, by the same rule the DOM path applies.
      if (tag === 'INPUT' && (get('type') ?? '').toLowerCase() === 'password') {
        entry.sensitive = true;
      } else if (
        namesSensitiveField(
          get('name'),
          get('id'),
          get('autocomplete'),
          get('placeholder'),
          get('aria-label'),
        )
      ) {
        entry.sensitive = true;
      }

      let inForm = false;
      for (let node = parent[index] ?? -1; node >= 0; node = parent[node] ?? -1) {
        if (tagOf(node) === 'FORM') {
          inForm = true;
          break;
        }
      }
      if (submitsForm(tag, get('type'), inForm)) entry.submits = true;

      // The ancestor walk, in the order the DOM version does it: a form posting
      // to a money endpoint stands on its own, a named container needs a card
      // field inside it to corroborate.
      for (let node = index; node >= 0; node = parent[node] ?? -1) {
        const posts = formMoney(node);
        if (posts) {
          entry.checkout = posts;
          break;
        }
        const named = namedForMoney(attrsOf(node));
        if (named && containsPayment[node]) {
          entry.checkout = `${named}, and it contains card fields`;
          break;
        }
      }

      const autocomplete = get('autocomplete');
      if (autocomplete) entry.autocomplete = autocomplete;
      if (tag === 'A') {
        const href = get('href');
        if (href) entry.href = href;
      }

      if (Object.keys(entry).length > 0) facts.set(backendNodeId, entry);
    }
  }

  return {
    for: (backendNodeId) => facts.get(backendNodeId),
    knows: (backendNodeId) => seen.has(backendNodeId),
  };
}
