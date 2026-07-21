/**
 * Chooses which READ-ONLY transport a connection gets.
 *
 * `STRIPE_CUSTOMER_TRANSPORT=fake` swaps in the deterministic in-memory
 * transport. That is what lets the demo, E2E runs and CI exercise the whole
 * connection-and-sync path — including checkpointing and retry — with no live
 * Stripe account and no production secrets, which the specification requires.
 *
 * Selection is made from validated configuration, never from a request. A
 * browser cannot ask to be served the fake transport.
 */
import { loadEnv, type Env } from "@payrecon/config/env";
import { createFakeStripeTransport, type FakeTransportOptions } from "./fake-transport";
import { createLiveStripeTransport } from "./live-transport";
import type { StripeTransportFactory } from "./connection-service";

export interface TransportFactoryOptions {
  env?: Env;
  /** Fixture data used when the fake transport is selected. */
  fake?: FakeTransportOptions;
}

/**
 * Build the factory used by `createConnection` / `revalidateConnection`.
 *
 * The restricted key reaches the Stripe client and nothing else: it is revealed
 * once, at construction, and never returned or stored by the factory.
 */
export function createTransportFactory(
  options: TransportFactoryOptions = {},
): StripeTransportFactory {
  const env = options.env ?? loadEnv();

  if (env.STRIPE_CUSTOMER_TRANSPORT === "fake") {
    return ({ livemode }) =>
      createFakeStripeTransport({
        ...options.fake,
        account: { livemode, ...options.fake?.account },
      });
  }

  return ({ restrictedKey, livemode }) =>
    createLiveStripeTransport({
      restrictedKey: restrictedKey.reveal(),
      livemode,
      rateLimitRps: env.STRIPE_CUSTOMER_RATE_LIMIT_RPS,
    });
}
