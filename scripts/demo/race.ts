/**
 * README §8, live: a wallet with 100.00 receives two BETs of 80.00 at the same time, each sent to
 * a different instance when several are given (DEMO_API_URLS). Exactly one is processed, the
 * other is rejected with INSUFFICIENT_FUNDS, and the balance ends at 20.00, never negative.
 *
 *   bun run demo:race
 *   DEMO_API_URLS=http://localhost:3000,http://localhost:3001 bun run demo:race
 */
import {
  apiUrls,
  createWallet,
  getWallet,
  operation,
  printLedger,
  reconcile,
  submit,
} from './shared';

const [first = 'http://localhost:3000', second = first] = apiUrls;

const wallet = await createWallet(first, '100.00');
console.log(`Wallet ${wallet.id} opened with ${wallet.balance.amount} BRL\n`);

console.log(`Two BETs of 80.00 in parallel: one to ${first}, one to ${second}`);
const results = await Promise.all([
  submit(first, operation(wallet, 'BET', '80.00')),
  submit(second, operation(wallet, 'BET', '80.00')),
]);

console.table(
  results.map(({ status, body }, index) => ({
    instance: index === 0 ? first : second,
    http: status,
    status: body.status,
    failureCode: body.failureCode ?? '',
    balance: body.balance?.amount ?? '',
  })),
);

const after = await getWallet(first, wallet.id);
console.log(`Final balance: ${after.balance.amount} BRL (version ${String(after.version)})`);
await printLedger(first, wallet.id);
console.log(`Reconciliation consistent: ${String(await reconcile(first, wallet.id))}`);
