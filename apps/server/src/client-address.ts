/**
 * Who the client is, for a rate limit — `APP_TRUST_PROXY` widened and `APP_TRUSTED_CLIENT_IP_HEADER`
 * (WP-280, TD-031 decision 10c).
 *
 * ## `APP_TRUST_PROXY`: `false | true | <addresses or CIDRs>`
 *
 * One setting decides which peers may speak for a client, so no second list exists. Its forms are
 * the ones Fastify's `trustProxy` accepts (https://fastify.dev/docs/latest/Reference/Server/#trustproxy,
 * read for WP-280: a boolean, a string or array of IP/CIDR entries, a hop count, or a function):
 *
 * - **`false`** (the default) trusts no peer: `request.ip` is the socket address and no forwarding
 *   header is believed anywhere.
 * - **`true`** trusts every peer. It is safe **only** when the core's port is unreachable except
 *   through the proxy (`docs/operator-guide.md` says so): anybody who reaches the port directly can
 *   then choose their own address.
 * - **A comma-separated list of addresses and CIDR ranges** trusts exactly those peers — the proxy
 *   or the CDN's ranges — and is handed to Fastify as an array.
 *
 * The old boolean spellings keep their meaning (`true/1/yes/on`, `false/0/no/off`), so `1` is still
 * `true`. Any other bare integer is **refused at start-up**: Fastify reads a number as a hop count,
 * which trusts whatever the nearest hops claim without checking who the immediate peer is — the
 * page above now says hop-count-only trust is disabled for exactly that reason — and an operator
 * who meant one address does not get a hop count by accident.
 *
 * ## The client address of a rate limit
 *
 * {@link resolveClientAddress}: when `APP_TRUSTED_CLIENT_IP_HEADER` names a header (e.g.
 * `cf-connecting-ip` behind Cloudflare) **and** the request's **socket peer** is trusted by the
 * setting above, the header's value is the client — if it is an IP address; anything else falls back.
 * Otherwise it is Fastify's `request.ip`, which is the socket address unless the peer is trusted
 * (then the `X-Forwarded-For` resolution Fastify does under the same setting). So a forged header
 * from an untrusted peer changes nothing: the request is keyed by its socket address.
 *
 * An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`, what a dual-stack socket reports) is the IPv4
 * address, in the trust check and in the key, so one client cannot hold two buckets.
 */
import { BlockList, isIP } from 'node:net';

/** `APP_TRUST_PROXY` after parsing. An array is a list of addresses and CIDR ranges. */
export type TrustProxySetting = boolean | readonly string[];

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** `::ffff:a.b.c.d` → `a.b.c.d`; every other spelling unchanged. */
export const normaliseAddress = (address: string): string => {
  const mapped = MAPPED_IPV4.exec(address);
  return mapped?.[1] ?? address;
};

/**
 * Whether one `APP_TRUST_PROXY` entry is an address or a CIDR range Fastify and this module accept
 * — never a bare integer, which would be a hop count.
 */
export const isTrustProxyEntry = (entry: string): boolean => {
  const [address, prefix, extra] = entry.split('/');
  if (address === undefined || extra !== undefined) {
    return false;
  }
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d{1,3}$/.test(prefix)) {
    return false;
  }
  return Number(prefix) <= (family === 4 ? 32 : 128);
};

/** A predicate over a socket address: is this peer trusted to speak for a client? */
export const compileTrust = (setting: TrustProxySetting): ((address: string) => boolean) => {
  if (setting === true) {
    return () => true;
  }
  if (setting === false) {
    return () => false;
  }
  const list = new BlockList();
  for (const entry of setting) {
    const [address = '', prefix] = entry.split('/');
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) {
      list.addAddress(normaliseAddress(address), type);
    } else {
      list.addSubnet(address, Number(prefix), type);
    }
  }
  return (address) => {
    const normalised = normaliseAddress(address);
    const family = isIP(normalised);
    return family !== 0 && list.check(normalised, family === 6 ? 'ipv6' : 'ipv4');
  };
};

export interface ClientAddressInput {
  /** The TCP peer — `request.socket.remoteAddress`. */
  readonly socketAddress: string | undefined;
  /** Fastify's `request.ip`, already resolved under the same trust setting. */
  readonly requestIp: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly trusted: (address: string) => boolean;
  /** `APP_TRUSTED_CLIENT_IP_HEADER`, lower-cased, or `null`. */
  readonly trustedHeader: string | null;
}

/** The address a rate limit keys on; the module docblock has the rule. */
export const resolveClientAddress = (input: ClientAddressInput): string => {
  const socket = input.socketAddress === undefined ? null : normaliseAddress(input.socketAddress);
  if (input.trustedHeader !== null && socket !== null && input.trusted(socket)) {
    const raw = input.headers[input.trustedHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value !== undefined && isIP(normaliseAddress(value)) !== 0) {
      return normaliseAddress(value);
    }
  }
  return normaliseAddress(input.requestIp);
};
