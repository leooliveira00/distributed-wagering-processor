import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import { InvalidRequestError } from '../../../application/errors';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/system';
import { SubmitWagerTransaction } from '../../../application/wagering/submit-wager-transaction';
import { GetWagerTransaction } from '../../../application/wagering/wager-queries';
import {
  type WagerSubmissionResult,
  type WagerTransactionView,
} from '../../../application/wagering/wager-views';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import { IDEMPOTENCY_KEY_PATTERN, wagerOperationSchema } from '../../contracts/wager-contract';
import { type AuthenticatedRequest } from '../auth/provider-auth.guard';
import { type HttpErrorBody } from '../errors/http-error-mapping';
import { requestContextFrom } from '../request-context';
import { parseInput } from '../validation';
import { FAILURE_MESSAGES } from './failure-messages';

const IDEMPOTENCY_HEADER = 'idempotency-key';

const transactionIdSchema = z.uuid();
const providerParamsSchema = z.object({
  providerId: z.string().min(1).max(64),
  externalTransactionId: z.string().min(1).max(128),
});

/** Status per outcome; a replay answers exactly like the original submission. */
const STATUS_BY_OUTCOME: Readonly<Partial<Record<WagerTransactionStatus, number>>> = {
  [WagerTransactionStatus.Processed]: HttpStatus.CREATED,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  // Replay of a transaction the pending worker gave up on: a permanent server-side failure, not
  // a business rejection. The envelope says retryable=false: resending will not change it.
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

type SubmissionResponse = WagerSubmissionResult & Partial<HttpErrorBody>;

interface StatusResponse {
  status(code: number): unknown;
}

@Controller()
export class WageringController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransaction,
    private readonly getTransaction: GetWagerTransaction,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<SubmissionResponse> {
    const idempotencyKey = headers[IDEMPOTENCY_HEADER];
    if (idempotencyKey === undefined || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new InvalidRequestError(
        'Idempotency-Key header is required: 1 to 255 visible ASCII characters',
        [{ path: 'headers.idempotency-key', message: 'Required' }],
        'INVALID_IDEMPOTENCY_KEY',
      );
    }
    const payload = parseInput(wagerOperationSchema, body);

    // README §2: the provider identity carried by the request is subject to domain checks.
    const identity = request.providerIdentity;
    if (identity && identity.providerId !== payload.providerId) {
      throw new ForbiddenException('providerId does not match the authenticated provider');
    }

    const result = await this.submitTransaction.execute(
      { ...payload, idempotencyKey },
      requestContextFrom(headers, this.ids),
    );

    response.status(STATUS_BY_OUTCOME[result.status] ?? HttpStatus.OK);
    const decidedAgainst =
      result.status === WagerTransactionStatus.Rejected ||
      result.status === WagerTransactionStatus.Failed;
    if (decidedAgainst && result.failureCode !== null) {
      // Rejections carry the transaction (it is persisted and auditable) and the uniform
      // error envelope used by every other 4xx/5xx, so clients handle all errors one way.
      return {
        ...result,
        error: {
          code: result.failureCode,
          message: FAILURE_MESSAGES[result.failureCode],
          retryable: false,
        },
      };
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return this.getTransaction.byId(parseInput(transactionIdSchema, transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(@Param() params: unknown): Promise<WagerTransactionView> {
    const { providerId, externalTransactionId } = parseInput(providerParamsSchema, params);
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}
