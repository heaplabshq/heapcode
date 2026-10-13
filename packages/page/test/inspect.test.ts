// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { inspect, testIdOf } from '../src/inspect.js';
import { fingerprintOf, pathOf } from '../src/fingerprint.js';
import { findSimilar, textSimilarity } from '../src/similarity.js';

function page(html: string): Document {
  document.documentElement.innerHTML = `<head><title>t</title></head><body>${html}</body>`;
  return document;
}

const byAttr = (tree: ReturnType<typeof inspect>, attr: string, value: string): number =>
  tree.nodes.find((n) => n.attrs[attr] === value)!.id;

describe('inspect', () => {
  it('reads the whole tree with roles, names, own text and attributes', () => {
    const tree = inspect(
      page(`<main><h1>Sign up</h1><form>
        <label for="e">Email</label><input id="e" name="email" type="email" value="a@b.c">
        <input type="password" name="pw" value="secret">
        <button data-testid="go" class="btn primary">Create <b>account</b></button>
      </form><script>ignored()</script></main>`),
    );
    const button = tree.nodes[byAttr(tree, 'data-testid', 'go')]!;
    expect(button).toMatchObject({ tag: 'button', role: 'button', name: 'Create account', text: 'Create' });
    expect(tree.nodes.some((n) => n.tag === 'script')).toBe(false);
    const email = tree.nodes[byAttr(tree, 'id', 'e')]!;
    expect(email).toMatchObject({ role: 'textbox', name: 'Email', value: 'a@b.c' });
    // A password's value never leaves the page.
    expect(tree.nodes[byAttr(tree, 'name', 'pw')]!.value).toBeUndefined();
    expect(testIdOf(button)).toEqual({ attr: 'data-testid', value: 'go' });
  });

  it('goes into open shadow roots and links parents to children', () => {
    const doc = page('<div id="host"></div>');
    const host = doc.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Inside</button>';
    const elements: Element[] = [];
    const tree = inspect(doc, {}, elements);
    const inner = tree.nodes.find((n) => n.name === 'Inside')!;
    expect(inner.shadow).toBe(true);
    expect(tree.nodes[inner.parent!]!.attrs.id).toBe('host');
    expect(tree.nodes[inner.parent!]!.children).toContain(inner.id);
    expect(elements[inner.id]!.textContent).toBe('Inside');
  });

  it('stops at maxNodes and says so', () => {
    const tree = inspect(page('<p>a</p>'.repeat(50)), { maxNodes: 10 });
    expect(tree.nodes).toHaveLength(10);
    expect(tree.truncated).toBe(true);
  });
});

describe('fingerprint', () => {
  it('records path, label text and identifying attributes', () => {
    const tree = inspect(page('<form><label for="q">Search</label><input id="q" name="q" placeholder="Find"></form>'));
    const fp = fingerprintOf(tree, byAttr(tree, 'id', 'q'));
    expect(fp).toMatchObject({ tag: 'input', id: 'q', neighborText: 'Search', attrs: { name: 'q', placeholder: 'Find' } });
    expect(pathOf(tree, tree.nodes[byAttr(tree, 'id', 'q')]!)).toBe('html/body[1]/form[1]/input[1]');
  });
});

describe('findSimilar', () => {
  it('finds a button again after its id and position change', () => {
    const before = inspect(page('<nav><a href="/">Home</a></nav><form><button id="save-1" class="btn">Save changes</button><button id="c">Cancel</button></form>'));
    const saved = fingerprintOf(before, byAttr(before, 'id', 'save-1'));

    const after = inspect(page('<nav><a href="/">Home</a></nav><form><button id="c">Cancel</button><div><button id="save-9f3" class="btn btn-lg">Save changes</button></div></form>'));
    const result = findSimilar(saved, after);
    expect(after.nodes[result.best!.nodeId]!.attrs.id).toBe('save-9f3');
    expect(result.margin).toBeGreaterThan(0.2);
  });

  it('prefers the test id over everything else', () => {
    const before = inspect(page('<button data-testid="buy">Buy</button>'));
    const saved = fingerprintOf(before, byAttr(before, 'data-testid', 'buy'));
    const after = inspect(page('<button>Buy</button><button data-testid="buy">Purchase now</button>'));
    expect(after.nodes[findSimilar(saved, after).best!.nodeId]!.attrs['data-testid']).toBe('buy');
  });

  it('has a small margin when two candidates look alike', () => {
    const before = inspect(page('<ul><li><button>Add</button></li></ul>'));
    const saved = fingerprintOf(before, before.nodes.find((n) => n.tag === 'button')!.id);
    const after = inspect(page('<ul><li><button>Add</button></li><li><button>Add</button></li></ul>'));
    expect(findSimilar(saved, after).margin).toBeLessThan(0.1);
  });
});

describe('textSimilarity', () => {
  it('scores rewording by shared words', () => {
    expect(textSimilarity('Save changes', 'save  CHANGES')).toBe(1);
    expect(textSimilarity('Save changes', 'Save all changes')).toBeGreaterThan(0.7);
    expect(textSimilarity('Save', 'Delete')).toBe(0);
  });
});
