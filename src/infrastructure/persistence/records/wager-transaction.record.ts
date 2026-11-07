import { EntitySchema } from '@mikro-orm/core';
import { WalletRecord } from './wallet.record';

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  /** Relation (not a bare id) so the unit of work inserts the wallet before its transactions. */
  wallet!: WalletRecord;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransaction!: WagerTransactionRecord | null;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  observedBalanceCurrency!: string | null;
  attempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    wallet: { kind: 'm:1', entity: () => WalletRecord, fieldName: 'wallet_id' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    observedBalance: { type: 'decimal', precision: 20, scale: 2, nullable: true },
    observedBalanceCurrency: { type: 'string', columnType: 'char(3)', nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz(3)', nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz(3)' },
    processedAt: { type: 'datetime', columnType: 'timestamptz(3)', nullable: true },
  },
});
