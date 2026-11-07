import { type SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { FAULT_INJECTOR } from '../../application/ports/fault-injector';
import { MESSAGE_PUBLISHER } from '../../application/ports/message-publisher';
import { ENV } from '../config/config.module';
import { type Env } from '../config/env';
import { EnvFaultInjector } from '../testing/env-fault-injector';
import { createSqsClient } from './sqs/sqs-client';
import { SqsMessagePublisher } from './sqs/sqs-message-publisher';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [ENV], useFactory: (env: Env) => createSqsClient(env) },
    {
      provide: MESSAGE_PUBLISHER,
      inject: [SQS_CLIENT, ENV],
      useFactory: (sqs: SQSClient, env: Env) =>
        new SqsMessagePublisher(sqs, env.SQS_EVENTS_QUEUE_NAME),
    },
    {
      provide: FAULT_INJECTOR,
      inject: [ENV],
      useFactory: (env: Env) => new EnvFaultInjector(env.FAULT_INJECTION),
    },
  ],
  exports: [SQS_CLIENT, MESSAGE_PUBLISHER, FAULT_INJECTOR],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
