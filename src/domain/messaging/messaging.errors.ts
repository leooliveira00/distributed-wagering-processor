import { DomainError } from '../shared/domain-error';

export class InvalidMessageError extends DomainError {
  readonly code = 'INVALID_MESSAGE';
}

/** Transition attempted on a message that already reached its final state (programming error). */
export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';
}
