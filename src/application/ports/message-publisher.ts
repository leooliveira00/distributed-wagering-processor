import { type OutboxMessage } from '../../domain/messaging/outbox-message';

/** Delivers an integration event to the broker. At-least-once: callers retry on failure. */
export interface MessagePublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export const MESSAGE_PUBLISHER = Symbol('MESSAGE_PUBLISHER');
