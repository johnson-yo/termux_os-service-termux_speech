/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An HTTP Authorization header and the Framework-injected System Key.
 * [OUTPUT]: Whether the request carries the exact shared System Key.
 * [POS]: service/http-auth.mjs in a generated Extension Package.
 * [PROTOCOL]: Never log, persist, or copy the System Key.
 */

export function systemKeyAuthorized(header, systemKey) {
  return Boolean(systemKey) && header === `Bearer ${systemKey}`;
}
