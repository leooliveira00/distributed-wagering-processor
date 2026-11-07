import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { type TestQueue } from '../../integration/support/test-queue';

/** Polls `condition` until it holds; fails with `what` once `timeoutMs` has passed. */
export async function eventually(
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) return;
    } catch {
      // the dependency may still be recovering: keep polling until the deadline
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)}ms: ${what}`);
    await Bun.sleep(200);
  }
}

/** Visible plus in-flight messages: zero only when every message was deleted. */
export async function queueDepth(queue: TestQueue): Promise<number> {
  const { Attributes = {} } = await queue.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes.ApproximateNumberOfMessages ?? '0') +
    Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}
