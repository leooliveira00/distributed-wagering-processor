import { type SQL } from 'bun';
import { expect } from 'bun:test';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction-status';
import { expectLedgerConsistent } from '../../integration/support/invariants';
import { bet, openWallet, submit } from './wagering-client';

/**
 * Concurrency scenarios of README §8 and §13, written once and run against any topology:
 * `pick()` returns the base URL for each request (one in-process app, or N real processes).
 */

async function debitEntries(sql: SQL, walletId: string): Promise<number> {
  const rows: { count: number }[] = await sql.unsafe(
    `select count(*)::int as count from wallet_ledger_entries
      where wallet_id = $1 and direction = 'DEBIT'`,
    [walletId],
  );
  return rows[0]?.count ?? -1;
}

async function balanceOf(sql: SQL, walletId: string): Promise<string> {
  const rows: { balance: string }[] = await sql.unsafe(
    'select balance::text as balance from wallets where id = $1',
    [walletId],
  );
  return rows[0]?.balance ?? 'missing';
}

/** §13.1: the same BET sent 50 times in parallel produces a single debit. */
export async function sameBetFiftyTimes(sql: SQL, pick: () => string): Promise<void> {
  const wallet = await openWallet(pick(), '1000.00');
  const body = bet(wallet, '25.00');

  const responses = await Promise.all(Array.from({ length: 50 }, () => submit(pick(), body)));

  expect(new Set(responses.map((response) => response.status))).toEqual(new Set([201]));
  expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
  expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
  expect(new Set(responses.map((response) => response.body.balance?.amount))).toEqual(
    new Set(['975.00']),
  );
  expect(await debitEntries(sql, wallet.id)).toBe(1);
  expect(await balanceOf(sql, wallet.id)).toBe('975.00');
  await expectLedgerConsistent(sql, wallet.id);
}

/** §8 mandatory scenario: 100.00 and two simultaneous BETs of 80.00, repeated `rounds` times. */
export async function competingBets(sql: SQL, pick: () => string, rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    const wallet = await openWallet(pick(), '100.00');
    const first = bet(wallet, '80.00');
    const second = bet(wallet, '80.00');

    const responses = await Promise.all([submit(pick(), first), submit(pick(), second)]);

    const processed = responses.filter(
      (response) => response.body.status === WagerTransactionStatus.Processed,
    );
    const rejected = responses.filter(
      (response) => response.body.status === WagerTransactionStatus.Rejected,
    );
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe(422);
    expect(rejected[0]?.body.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(sql, wallet.id)).toBe('20.00');
    expect(await debitEntries(sql, wallet.id)).toBe(1);

    // Retries of both requests never duplicate the debit.
    const retries = await Promise.all([submit(pick(), first), submit(pick(), second)]);
    expect(retries.every((response) => response.body.idempotentReplay)).toBe(true);
    expect(await debitEntries(sql, wallet.id)).toBe(1);
    await expectLedgerConsistent(sql, wallet.id);
  }
}

/** Hot wallet: 30 distinct BETs of 10.00 race for 100.00; exactly 10 can win. */
export async function hotWallet(sql: SQL, pick: () => string): Promise<void> {
  const wallet = await openWallet(pick(), '100.00');

  const responses = await Promise.all(
    Array.from({ length: 30 }, () => submit(pick(), bet(wallet, '10.00'))),
  );

  expect(
    responses.filter((response) => response.body.status === WagerTransactionStatus.Processed),
  ).toHaveLength(10);
  expect(
    responses.filter((response) => response.body.status === WagerTransactionStatus.Rejected),
  ).toHaveLength(20);
  expect(await balanceOf(sql, wallet.id)).toBe('0.00');
  expect(await debitEntries(sql, wallet.id)).toBe(10);
  await expectLedgerConsistent(sql, wallet.id);
}

/** §13.3: independent wallets processed in parallel all end up exactly right. */
export async function independentWallets(sql: SQL, pick: () => string): Promise<void> {
  const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(pick(), '100.00')));

  const responses = await Promise.all(
    wallets.flatMap((wallet) =>
      Array.from({ length: 10 }, () => submit(pick(), bet(wallet, '1.00'))),
    ),
  );

  expect(responses.every((response) => response.status === 201)).toBe(true);
  for (const wallet of wallets) {
    expect(await balanceOf(sql, wallet.id)).toBe('90.00');
    expect(await debitEntries(sql, wallet.id)).toBe(10);
    await expectLedgerConsistent(sql, wallet.id);
  }
}
