import {
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../application/ports/provider-identity';

/**
 * No-op adapter: authentication is out of scope (README §2) and every request is anonymous.
 * Replacing it with a JWKS-validating adapter requires no change in controllers or use cases.
 */
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  readonly enforced = false;

  resolve(): Promise<ProviderIdentity | undefined> {
    return Promise.resolve(undefined);
  }
}
