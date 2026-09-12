import type { WorkbenchState } from "@/server/ledger/queries";

export function securityTransferListing(state: Pick<WorkbenchState, "listings" | "security_transits">, receiving: boolean, id: string) {
  if (receiving) {
    const lot = state.security_transits.find(row => row.transfer_event_id === id);
    return lot ? { id: lot.listing_id, currency: lot.currency } : undefined;
  }
  const listing = state.listings.find(row => row.id === id);
  return listing ? { id: listing.id, currency: listing.currency } : undefined;
}
