import { EntitySchema } from '@mikro-orm/core';
import { WagerTransactionRecord } from './wager-transaction.record';
import { WalletRecord } from './wallet.record';

/**
 * Append-only. The `seq` identity column is intentionally not mapped: the database generates it
 * and per-wallet ordering uses `walletVersion`, which is gap-free and unique per wallet.
 */
export class LedgerEntryRecord {
  id!: string;
  wallet!: WalletRecord;
  currency!: string;
  transaction!: WagerTransactionRecord;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    wallet: { kind: 'm:1', entity: () => WalletRecord, fieldName: 'wallet_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      fieldName: 'transaction_id',
    },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz(3)' },
  },
});
