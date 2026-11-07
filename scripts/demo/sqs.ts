/**
 * README §10, live: a BET arrives through `wager-transactions.fifo` and is delivered TWICE, with
 * different deduplication ids so the broker cannot drop the copy (as at-least-once delivery may
 * do). The persistent inbox turns the second delivery into a replay: one debit, not two.
 *
 *   bun run demo:sqs
 */
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { type WagerTransactionView } from '../../src/application/wagering/wager-views';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import {
  apiUrls,
  createWallet,
  demoEnv,
  demoSqs,
  getWallet,
  idempotencyKeyOf,
  operation,
  printLedger,
  providerId,
  reconcile,
} from './shared';

const [api = 'http://localhost:3000'] = apiUrls;
const env = demoEnv();
const sqs = demoSqs(env);

const wallet = await createWallet(api, '100.00');
console.log(`Wallet ${wallet.id} opened with ${wallet.balance.amount} BRL\n`);

const bet = operation(wallet, 'BET', '10.00');
const envelope = {
  messageId: `msg-${bet.externalTransactionId}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: { ...bet, idempotencyKey: idempotencyKeyOf(bet) },
};

const { QueueUrl } = await sqs.send(
  new GetQueueUrlCommand({ QueueName: env.SQS_WAGER_QUEUE_NAME }),
);
for (const copy of [1, 2]) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  console.log(`Delivery ${String(copy)} of ${envelope.messageId} sent (BET 10.00)`);
}

const lookup = `${api}/providers/${providerId}/wagering/transactions/${bet.externalTransactionId}`;
// A message handed to a process that died (e.g. right after `docker kill`) only becomes visible
// again after the queue's visibility timeout (30s): at-least-once delivery, not a loss.
const started = Date.now();
let warned = false;
let transaction: WagerTransactionView | undefined;
while (Date.now() - started < 60_000) {
  const response = await fetch(lookup);
  if (response.status === 200) {
    transaction = (await response.json()) as WagerTransactionView;
    if (transaction.status !== WagerTransactionStatus.PendingReference) break;
  }
  if (!warned && Date.now() - started > 5_000) {
    console.log('Still waiting: if a consumer just died holding it, it reappears within 30s...');
    warned = true;
  }
  await Bun.sleep(500);
}
if (!transaction) throw new Error('the consumer did not process the message in 60s');

// Give the duplicate delivery time to be consumed (and recognized) before showing the ledger.
await Bun.sleep(3_000);
console.log(`\nTransaction ${transaction.transactionId}: ${transaction.status}`);
const after = await getWallet(api, wallet.id);
console.log(`Final balance: ${after.balance.amount} BRL (one debit for two deliveries)`);
await printLedger(api, wallet.id);
console.log(`Reconciliation consistent: ${String(await reconcile(api, wallet.id))}`);
sqs.destroy();
