/**
 * THE DECLARATION REGISTRY — every tool an agent's process has handed an adapter, by service, declared as one list.
 *
 * `declare_tools` replaces a service's whole list, so an adapter that declared each batch it was given would undo
 * itself: two tool sets for one service, guarded one after the other, would leave the platform with only the second
 * and the first marked no longer declared. The registry keeps the union per service and declares that, once the
 * adds of one start have settled, and again only when a service's list changed.
 */
import type { ViaMcpClient } from './client.js';
import { declareTools, wireTool, type DeclareToolsOptions, type DeclaredTool, type ServiceDeclaration } from './declare.js';

export interface ToolRegistryOptions extends Pick<DeclareToolsOptions, 'onWarning'> {
  /** How long the adds of one start may keep coming before the registry declares. Default 25 ms. */
  settleMs?: number;
}

interface Waiting {
  promise: Promise<ServiceDeclaration[]>;
  resolve: (d: ServiceDeclaration[]) => void;
  reject: (e: unknown) => void;
}

export class ToolRegistry {
  /** service → the name the agent calls each tool by → the tool. */
  private readonly services = new Map<string, Map<string, DeclaredTool>>();
  /** service → what was last declared for it, on the wire, to skip a declaration that changes nothing. */
  private readonly declared = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: Waiting | undefined;
  /** The flush in progress: flushes run one after another, never two declarations for one agent at once. */
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly humanos: ViaMcpClient,
    private readonly did: string,
    private readonly options: ToolRegistryOptions = {},
  ) {}

  /**
   * Add tools to their services; the declaration follows once the adds stop for `settleMs`. Resolves with what that
   * declaration recorded. An adapter may leave it unawaited: a call to a tool not yet declared is still decided, and
   * a declaration that fails is a warning, not a crash.
   */
  add(tools: DeclaredTool[]): Promise<ServiceDeclaration[]> {
    for (const t of tools) {
      const service = this.services.get(t.service) ?? new Map<string, DeclaredTool>();
      service.set(t.calledAs ?? t.name, t);
      this.services.set(t.service, service);
    }
    if (!this.waiting) {
      let resolve!: Waiting['resolve'];
      let reject!: Waiting['reject'];
      const promise = new Promise<ServiceDeclaration[]>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {}); // handled: the timer's flush reports the failure; an awaiting caller still sees it
      this.waiting = { promise, resolve, reject };
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().catch((e: unknown) => this.warn(`declaring the agent's tools failed: ${e instanceof Error ? e.message : String(e)}`));
    }, this.options.settleMs ?? 25);
    return this.waiting.promise;
  }

  /** Declare every service whose list changed since it was last declared, now. */
  flush(): Promise<ServiceDeclaration[]> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const waiting = this.waiting;
    this.waiting = undefined;
    const run = this.running.then(() => this.declareChanged());
    this.running = run.catch(() => {});
    run.then(
      (d) => waiting?.resolve(d),
      (e: unknown) => waiting?.reject(e),
    );
    return run;
  }

  /** Every tool added, by service: what the platform has, or will have after the next flush. */
  tools(): DeclaredTool[] {
    return [...this.services.values()].flatMap((s) => [...s.values()]);
  }

  private async declareChanged(): Promise<ServiceDeclaration[]> {
    const changed: DeclaredTool[] = [];
    const sent = new Map<string, string>();
    for (const [service, tools] of this.services) {
      const list = [...tools.values()];
      const wire = JSON.stringify(list.map(wireTool));
      if (this.declared.get(service) === wire) continue;
      sent.set(service, wire);
      changed.push(...list);
    }
    if (!changed.length) return [];
    const declarations = await declareTools(this.humanos, this.did, changed, { onWarning: (m) => this.warn(m) });
    for (const [service, wire] of sent) this.declared.set(service, wire);
    return declarations;
  }

  private warn(message: string): void {
    if (this.options.onWarning) this.options.onWarning(message);
    else process.stderr.write(`via: ${message}\n`);
  }
}
