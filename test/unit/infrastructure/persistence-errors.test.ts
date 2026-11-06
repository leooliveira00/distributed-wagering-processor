import {
  DeadlockException,
  OptimisticLockError,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { describe, expect, it } from 'bun:test';
import {
  IntegrityViolationError,
  TransientError,
  UniqueViolationError,
} from '../../../src/application/errors';
import { translatePersistenceError } from '../../../src/infrastructure/persistence/persistence-errors';

/** Raw `pg` error as it surfaces at COMMIT (not converted by the ORM). */
const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error(`pg ${code}`), { code, constraint });

describe('translatePersistenceError', () => {
  it('keeps the constraint name of a converted unique violation', () => {
    const error = new UniqueConstraintViolationException(
      pgError('23505', 'wallets_player_currency_uq'),
    );

    const translated = translatePersistenceError(error);

    expect(translated).toBeInstanceOf(UniqueViolationError);
    expect((translated as UniqueViolationError).constraint).toBe('wallets_player_currency_uq');
  });

  it('recognizes a raw unique violation too', () => {
    const translated = translatePersistenceError(pgError('23505', 'inbox_messages_pk'));

    expect((translated as UniqueViolationError).constraint).toBe('inbox_messages_pk');
  });

  it.each([
    ['an optimistic lock failure', OptimisticLockError.lockFailed('WalletRecord')],
    ['a deadlock', new DeadlockException(pgError('40P01'))],
    ['a raw lock timeout', pgError('55P03')],
    ['a raw serialization failure', pgError('40001')],
    ['a refused connection', pgError('ECONNREFUSED')],
  ])('classifies %s as transient', (_, error) => {
    expect(translatePersistenceError(error)).toBeInstanceOf(TransientError);
  });

  it.each([
    ['a deferred trigger check at commit', '23514'],
    ['an append-only ledger violation', '23001'],
    ['a foreign key violation', '23503'],
  ])('classifies %s as an integrity violation', (_, code) => {
    expect(translatePersistenceError(pgError(code, 'some_constraint'))).toBeInstanceOf(
      IntegrityViolationError,
    );
  });

  it('leaves unrelated errors untouched', () => {
    const error = new Error('business logic bug');

    expect(translatePersistenceError(error)).toBe(error);
  });
});
