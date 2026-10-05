/**
 * Minimal Cordis-compatible type surface used by the plugin.
 *
 * The real `@cordis/core` package exports a richer API. We keep this
 * declaration local so the plugin type-checks even when the consumer
 * hasn't installed Cordis yet. At runtime, Cordis treats the plugin
 * function as a plain async install hook.
 *
 * `tool()` is optional: hosts that don't implement the DSH TypeScript
 * Tool Contract simply skip tool registration (progressive enhancement).
 */

export interface CordisContext {
  readonly logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };
  service<T = unknown>(name: string, value: T): void;
  on(
    event: string,
    handler: (event: CordisEvent) => Promise<void> | void,
  ): void;
  emit(event: string, payload: unknown): void;
  /** Register a model-callable tool (DSH TypeScript Tool Contract). Optional. */
  tool?(definition: ToolDefinition): void;
}

export interface CordisEvent {
  sessionId: string;
  eventId?: string;
  payload?: Record<string, unknown>;
}

export interface CordisPlugin<O = unknown> {
  (ctx: CordisContext, options?: O): void | Promise<void>;
}

/**
 * Execution context handed to every tool run. DSH populates it from the
 * active session so tools inherit the caller's scope automatically.
 */
export interface ToolContext {
  sessionId: string;
  workspaceId?: string;
  userId?: string;
}

/**
 * DSH TypeScript Tool Contract: a named tool with a JSON-Schema parameter
 * declaration and an async run function. Kept structural (no runtime dep)
 * so any host satisfying the shape can consume it.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) describing the input object. */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** JSON Schema for the output object (documentation / validation). */
  returns?: Record<string, unknown>;
  run(input: I, ctx: ToolContext): Promise<O>;
}
