/**
 * Enigma GraphQL request shape (ENG-1388). Side-effect free so evaluation
 * scripts can run the exact production query without importing the factory's
 * AWS / DB wiring. The endpoint URL deliberately stays in
 * enigmaServiceFactory.ts: the vendor metering guard (ENG-701) requires any
 * file naming the vendor host to also meter the call.
 *
 * Every field requested here that Enigma bills for must be counted by
 * countEnigmaBilledFills (enigmaService.ts), or the ledger under-reports spend.
 */

import type { EnigmaSearchRequest } from './enigmaService';

export const ENIGMA_MATCH_THRESHOLD = 0.8;

// One brand, its first name, its websites (to confirm the match against our
// domain) and the latest 12-month card revenue + YoY growth.
//
// Cost ceiling per call: Enigma bills every value returned, including rows we
// discard. cardTransactions(first: 4) = 4 x 10 credits, name 2, websites
// (first: 5) = 5 x 2, so 52 credits (~$0.52) at worst; ~19 typical (ENG-1933).
// Raising any `first:` raises that ceiling and the monthly budget maths.
export const SEARCH_BRAND_QUERY = `
query SearchBrandCardRevenue($searchInput: SearchInput!, $cardTransactionConditions: ConnectionConditions!) {
  search(searchInput: $searchInput) {
    ... on Brand {
      id
      names(first: 1) { edges { node { name } } }
      websites(first: 5) { edges { node { website domain topLevelDomain } } }
      cardTransactions(first: 4, conditions: $cardTransactionConditions) {
        edges { node { quantityType period projectedQuantity periodStartDate periodEndDate platformBrandId } }
      }
    }
  }
}`;

const CARD_TRANSACTION_CONDITIONS = {
  filter: {
    AND: [
      { EQ: ['period', '12m'] },
      { EQ: ['rank', 0] },
      { IN: ['quantityType', ['card_revenue_amount', 'card_revenue_yoy_growth']] },
    ],
  },
};

export function buildSearchBrandBody(request: EnigmaSearchRequest): string {
  return JSON.stringify({
    query: SEARCH_BRAND_QUERY,
    variables: {
      searchInput: {
        entityType: 'BRAND',
        website: request.website,
        ...(request.name ? { name: request.name } : {}),
        matchThreshold: ENIGMA_MATCH_THRESHOLD,
        conditions: { limit: 1 },
      },
      cardTransactionConditions: CARD_TRANSACTION_CONDITIONS,
    },
  });
}
