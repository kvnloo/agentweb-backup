/**
 * ENG-2110 PR 3: the ONE IPv4 validator the host config and the backend's settings provider share, so the two sides can never
 * disagree about what a valid worker address is.
 *
 * Canonical dotted quad only: four decimal octets 0-255, no leading zeros ("0127.0.0.1", "000.0.0.0", "010.1.1.1" would be read as
 * octal or as a different address by some stacks), no hex or integer forms, no whitespace, no IPv6, no ports.
 */
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** The four octets of a canonical IPv4 literal, or null for anything else. */
export function parseIPv4(text: string): [number, number, number, number] | null {
  if (typeof text !== "string" || !IPV4.test(text)) return null;
  return text.split(".").map(Number) as [number, number, number, number];
}

export function isCanonicalIPv4(text: string): boolean {
  return parseIPv4(text) !== null;
}

/** RFC 1918 only: 10/8, 172.16/12, 192.168/16. */
export function isRfc1918(text: string): boolean {
  const o = parseIPv4(text);
  if (!o) return false;
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Why an address can never be the address a service binds to / is reached on, or null if it is usable: this-network (0/8, which
 * includes 0.0.0.0 = every interface), loopback (127/8), link-local (169.254/16, includes the metadata service), multicast (224/4)
 * and the reserved/broadcast block (240/4).
 */
export function unusableAddressReason(text: string): "unspecified" | "loopback" | "link-local" | "multicast" | "reserved" | null {
  const o = parseIPv4(text);
  if (!o) return null; // not an IPv4 literal at all: the caller's format check owns that
  const [a, b] = o;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return null;
}
