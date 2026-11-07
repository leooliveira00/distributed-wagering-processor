/** Authenticated caller: a game provider system (machine-to-machine), not an end user. */
export interface ProviderIdentity {
  providerId: string;
}

/**
 * Extension point for authentication (README §2). Authentication is intentionally not
 * implemented; the planned adapter validates an OIDC client-credentials JWT issued by an external
 * identity provider (Keycloak) and maps the client to a `providerId`.
 */
export interface ProviderIdentityPort {
  /** When true, requests without a resolvable identity are rejected with 401. */
  readonly enforced: boolean;
  resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
