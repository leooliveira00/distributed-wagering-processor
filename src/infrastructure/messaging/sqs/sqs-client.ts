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
  });
}
