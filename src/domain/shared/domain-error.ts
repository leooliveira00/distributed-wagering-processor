/**
 * Base class for violations of domain rules. Each subclass exposes a stable, machine-readable
 * `code` so outer layers can map it (HTTP status, SQS ack/retry) without parsing messages.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
