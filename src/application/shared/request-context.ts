/** Tracing metadata propagated from the entry point (HTTP request or queue message). */
export interface RequestContext {
  correlationId: string;
  /** Id of the request or message that caused the operation, when there is one. */
  causationId?: string | undefined;
}
