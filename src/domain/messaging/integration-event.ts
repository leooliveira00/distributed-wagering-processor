import { deepFreeze } from '../shared/deep-freeze';
import { InvalidMessageError } from './messaging.errors';

/** Identity and tracing metadata supplied by the use case that raises the event. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  /** Id of the message or request that caused this event, when there is one. */
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

/** Serialized envelope stored in the outbox payload and published to the broker. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Base envelope for integration events. `eventType` and `version` live on each concrete
 * type, never as loose strings at the call site, so the contract is versionable.
 * `data` must be plain JSON (MoneyProps, ISO strings): never domain instances.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    if (props.eventId.trim().length === 0 || props.aggregateId.trim().length === 0) {
      throw new InvalidMessageError('eventId and aggregateId are required');
    }
    if (props.correlationId.trim().length === 0) {
      throw new InvalidMessageError('correlationId is required');
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    // structuredClone detaches the payload from the caller before freezing it.
    this.data = deepFreeze(structuredClone(props.data));
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data),
    };
  }
}
