import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../../application/ports/provider-identity';

const IS_PUBLIC = 'auth:isPublic';

/** Marks a route as unauthenticated (health checks, README §2). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  providerIdentity?: ProviderIdentity;
}

/**
 * Global guard. Resolves the provider identity through the port and attaches it to the request;
 * rejects only when the adapter enforces authentication. With the current anonymous adapter it
 * lets every request through, keeping the extension point explicit in code.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const resolved = await this.identity.resolve(typeof header === 'string' ? header : undefined);
    if (resolved) request.providerIdentity = resolved;
    if (!resolved && this.identity.enforced) {
      throw new UnauthorizedException('A valid provider token is required');
    }
    return true;
  }
}
