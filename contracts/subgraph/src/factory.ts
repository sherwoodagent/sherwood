import { BigDecimal, BigInt, DataSourceContext } from "@graphprotocol/graph-ts";
import {
  SyndicateCreated,
  MetadataUpdated,
  SyndicateDeactivated,
} from "../generated/SyndicateFactory/SyndicateFactory";
import { SyndicateVault as SyndicateVaultTemplate } from "../generated/templates";
import { Syndicate } from "../generated/schema";

export function handleSyndicateCreated(event: SyndicateCreated): void {
  let syndicate = new Syndicate(event.params.id.toString());

  syndicate.vault = event.params.vault;
  syndicate.creator = event.params.creator;
  syndicate.metadataURI = event.params.metadataURI;
  syndicate.createdAt = event.block.timestamp;
  syndicate.active = true;
  syndicate.totalDeposits = BigDecimal.zero();
  syndicate.totalWithdrawals = BigDecimal.zero();

  syndicate.save();

  // Pass syndicateId via context so vault handlers can look it up in O(1)
  let context = new DataSourceContext();
  context.setString("syndicateId", event.params.id.toString());
  SyndicateVaultTemplate.createWithContext(event.params.vault, context);
}

export function handleMetadataUpdated(event: MetadataUpdated): void {
  let syndicate = Syndicate.load(event.params.id.toString());
  if (syndicate == null) return;

  syndicate.metadataURI = event.params.metadataURI;
  syndicate.save();
}

export function handleSyndicateDeactivated(event: SyndicateDeactivated): void {
  let syndicate = Syndicate.load(event.params.id.toString());
  if (syndicate == null) return;

  syndicate.active = false;
  syndicate.save();
}
