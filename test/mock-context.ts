/**
 * Mock Cordis context for testing the Memory Palace plugin without
 * requiring the real Cordis kernel. Records services, event handlers,
 * emitted events, logs AND registered tools.
 */

import type { CordisContext, CordisEvent, ToolDefinition } from '../src/types/cordis.js';

export interface MockContext extends CordisContext {
  services: Map<string, unknown>;
  handlers: Map<string, Array<(e: CordisEvent) => Promise<void> | void>>;
  emittedEvents: Array<{ name: string; payload: unknown }>;
  logs: Array<{ level: string; msg: string }>;
  tools: ToolDefinition[];
}

export function createMockContext(): MockContext {
  const services = new Map<string, unknown>();
  const handlers = new Map<string, Array<(e: CordisEvent) => Promise<void> | void>>();
  const emittedEvents: Array<{ name: string; payload: unknown }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const tools: ToolDefinition[] = [];

  const logger = {
    info: (msg: string) => logs.push({ level: 'info', msg }),
    warn: (msg: string) => logs.push({ level: 'warn', msg }),
    error: (msg: string) => logs.push({ level: 'error', msg }),
    debug: (msg: string) => logs.push({ level: 'debug', msg }),
  };

  return {
    logger,
    services,
    handlers,
    emittedEvents,
    logs,
    tools,
    service<T>(name: string, value: T) {
      services.set(name, value);
    },
    on(event: string, handler: (e: CordisEvent) => Promise<void> | void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event: string, payload: unknown) {
      emittedEvents.push({ name: event, payload });
      const list = handlers.get(event) ?? [];
      for (const h of list) {
        Promise.resolve(h({ sessionId: '', payload: payload as Record<string, unknown> })).catch(
          (err) => logs.push({ level: 'error', msg: String(err) }),
        );
      }
    },
    tool(def: ToolDefinition) {
      tools.push(def);
    },
  };
}
