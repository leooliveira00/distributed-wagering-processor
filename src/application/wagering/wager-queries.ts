import { NotFoundError } from '../errors';
import { type UnitOfWork } from '../ports/unit-of-work';
import { toTransactionView, type WagerTransactionView } from './wager-views';

function transactionNotFound(description: string): NotFoundError {
  return new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${description} not found`);
}

export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.run(
      (scope) => scope.transactions.findById(transactionId),
      { readOnly: true },
    );
    if (!transaction) throw transactionNotFound(transactionId);
    return toTransactionView(transaction);
  }

  async byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.run(
      (scope) => scope.transactions.findByExternalId(providerId, externalTransactionId),
      { readOnly: true },
    );
    if (!transaction) throw transactionNotFound(`${externalTransactionId} of ${providerId}`);
    return toTransactionView(transaction);
  }
}
