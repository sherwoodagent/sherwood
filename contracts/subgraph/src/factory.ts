import { BigDecimal, BigInt, DataSourceContext } from "@graphprotocol/graph-ts";
import {
  SyndicateCreated,
  MetadataUpdated,
  SyndicateDeactivated,
} from "../generated/SyndicateFactory/SyndicateFactory";
import { SyndicateVault } from "../generated/templates/SyndicateVault/SyndicateVault";
import { ERC20 } from "../generated/SyndicateFactory/ERC20";
import { SyndicateVault as SyndicateVaultTemplate } from "../generated/templates";
import { Syndicate, VaultLookup } from "../generated/schema";

export function handleSyndicateCreated(event: SyndicateCreated): void {
  let syndicate = new Syndicate(event.params.id.toString());

  syndicate.vault = event.params.vault;
  syndicate.creator = event.params.creator;
  syndicate.metadataURI = event.params.metadataURI;
  syndicate.subdomain = event.params.subdomain;
  syndicate.createdAt = event.block.timestamp;
  syndicate.active = true;
  syndicate.redemptionsLocked = false;
  syndicate.openDeposits = false;
  syndicate.totalDeposits = BigDecimal.zero();
  syndicate.totalWithdrawals = BigDecimal.zero();

  // Read asset decimals from vault → asset → decimals (default 18)
  let vaultContract = SyndicateVault.bind(event.params.vault);
  let assetResult = vaultContract.try_asset();
  let decimals = 18;
  if (!assetResult.reverted) {
    let erc20 = ERC20.bind(assetResult.value);
    let decimalsResult = erc20.try_decimals();
    if (!decimalsResult.reverted) {
      decimals = decimalsResult.value;
    }
  }
  syndicate.assetDecimals = decimals;

  syndicate.save();

  // Create reverse lookup for governor handlers to resolve vault → syndicate
  let lookup = new VaultLookup(event.params.vault.toHexString());
  lookup.syndicate = event.params.id.toString();
  lookup.save();

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
