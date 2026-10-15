import type { DomTree } from '@heapcode/page/tree';
import type { ConsoleLine, Driver, FailedRequest, PageInfo, Probe, Target } from '../src/driver.js';

/** An element as the fake page knows it: just the things probes match on. */
export interface FakeElement {
  testId?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string[];
}

/** A Driver over a list of fake elements, recording what was done to them. */
export class FakeDriver implements Driver {
  readonly actions: string[] = [];
  private page: PageInfo = { url: 'about:blank', title: '' };

  constructor(public elements: FakeElement[]) {}

  matches(probe: Probe): FakeElement[] {
    return this.elements.filter((e) => {
      switch (probe.strategy) {
        case 'testId':
          return e.testId === probe.testId;
        case 'role':
          return e.role === probe.role && (probe.name === undefined || e.name === probe.name);
        case 'label':
          return e.label === probe.label;
        case 'placeholder':
          return e.placeholder === probe.placeholder;
        case 'text':
          return e.text === probe.text;
        case 'css':
          return e.css?.includes(probe.css) ?? false;
      }
    });
  }

  private element(target: Target): FakeElement {
    if ('nodeId' in target) throw new Error('fake driver has no inspection');
    const found = this.matches(target.probe)[target.index];
    if (!found) throw new Error('no such element');
    return found;
  }

  async open(url: string): Promise<PageInfo> {
    this.page = { url, title: url };
    this.actions.push(`open ${url}`);
    return this.page;
  }
  current(): PageInfo {
    return this.page;
  }
  async inspect(): Promise<DomTree> {
    return { url: this.page.url, title: this.page.title, nodes: [], truncated: false };
  }
  async count(probe: Probe): Promise<number> {
    return this.matches(probe).length;
  }
  async click(target: Target): Promise<void> {
    this.actions.push(`click ${this.element(target).text ?? this.element(target).name}`);
  }
  async type(target: Target, text: string): Promise<void> {
    this.actions.push(`type ${text} into ${this.element(target).label ?? this.element(target).name}`);
  }
  async select(target: Target, option: string): Promise<void> {
    this.actions.push(`select ${option} in ${this.element(target).label}`);
  }
  async press(key: string): Promise<void> {
    this.actions.push(`press ${key}`);
  }
  async textOf(target: Target): Promise<string> {
    return this.element(target).text ?? '';
  }
  async isVisible(): Promise<boolean> {
    return true;
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  /** Console lines the next drain returns. */
  console: ConsoleLine[] = [];
  drainConsole(): ConsoleLine[] {
    const out = this.console;
    this.console = [];
    return out;
  }
  drainFailedRequests(): FailedRequest[] {
    return [];
  }
  async close(): Promise<void> {}
}
