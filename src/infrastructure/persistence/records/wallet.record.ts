import { EntitySchema } from '@mikro-orm/core';

/** Persistence shape of a wallet. The domain `Wallet` never depends on this class. */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  /** numeric(20,2) is hydrated as a decimal string, never as a JS number. */
  balance!: string;
  /** Optimistic lock: the ORM issues UPDATE ... WHERE version = ? and increments it. */
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'decimal', precision: 20, scale: 2 },
    version: { type: 'integer', version: true, default: 1 },
    createdAt: { type: 'datetime', columnType: 'timestamptz(3)' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz(3)' },
  },
});
