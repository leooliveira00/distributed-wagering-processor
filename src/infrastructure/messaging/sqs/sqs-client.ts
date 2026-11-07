import { SQSClient } from '@aws-sdk/client-sqs';
import { type Env } from '../../config/env';

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    // Points to the emulator locally; omitted in a real AWS environment.
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
    // The SDK applies no timeout by default, and `requestTimeout` alone only logs a warning: a
    // call on a silent connection would never return. With these bounds it fails with
    // ETIMEDOUT, and the consumer and the outbox publisher retry as for any transient failure.
    requestHandler: {
      connectionTimeout: env.SQS_CONNECT_TIMEOUT_MS,
      requestTimeout: env.SQS_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}
