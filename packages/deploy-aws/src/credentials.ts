/**
 * Region + credential resolution for the AWS runtime.
 *
 * Region comes from an explicit option, else `AWS_REGION` / `AWS_DEFAULT_REGION`.
 * No region is assumed — resolution fails closed rather than silently defaulting
 * to a region the caller did not choose.
 *
 * Credentials use `fromIni({ profile })` when a named profile is supplied,
 * otherwise the standard `fromNodeProviderChain()`. Credential material is never
 * logged or returned from this module — only the provider callback is passed to
 * the SDK clients.
 */

import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';

/** The SDK credential-provider callback type, taken from the provider itself. */
type CredentialProvider = ReturnType<typeof fromNodeProviderChain>;

export interface AwsRuntimeOptions {
  /** AWS region (else read from AWS_REGION / AWS_DEFAULT_REGION). */
  region?: string;
  /** Named credentials profile; when set, credentials load via fromIni. */
  profile?: string;
}

export function resolveRegion(options: AwsRuntimeOptions = {}): string {
  const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error(
      'AWS region is not configured: pass { region } or set AWS_REGION ' +
        '(no default region is assumed — fail-closed)',
    );
  }
  return region;
}

export function resolveCredentials(options: AwsRuntimeOptions = {}): CredentialProvider {
  return options.profile ? fromIni({ profile: options.profile }) : fromNodeProviderChain();
}
