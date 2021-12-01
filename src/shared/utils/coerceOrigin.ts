import OriginMismatchError from "@web-eid/web-eid-library/errors/OriginMismatchError";

/**
 * Applies the trusted origin to a partial URL.
 *
 * In case the provided `url` has an origin, checks that the origin matches the trusted origin.
 *
 * @param trustedOrigin The trusted origin to coerce
 * @param url The full or partial URL where the trusted origin will be coerced
 *
 * @returns Provided full URL where the origin is the trustedOrigin
 * @throws OriginMismatchError when URL origin does not match the provided trusted origin
 */
export default function coerceOrigin(trustedOrigin: string, url: string): string {
  const urlWithTrustedBase = new URL(url, trustedOrigin);

  if (trustedOrigin !== urlWithTrustedBase.origin) {
    throw new OriginMismatchError(
      `expected origin ${trustedOrigin} for URL ${urlWithTrustedBase}, ` +
      "see https://github.com/web-eid/web-eid.js#cors for secure CORS setup instructions"
    );
  }

  return urlWithTrustedBase.href;
}
