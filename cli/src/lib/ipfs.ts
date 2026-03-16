/**
 * IPFS metadata upload/fetch via Pinata.
 *
 * Used for syndicate metadata (name, description, strategies, terms).
 * Requires PINATA_API_KEY and PINATA_GATEWAY env vars.
 */

export interface SyndicateMetadata {
  schema: string;
  name: string;
  description: string;
  logo?: string;
  chain: string;
  strategies: {
    id: string;
    name: string;
    description: string;
    protocols: string[];
    riskLevel: string;
  }[];
  terms: {
    minDeposit?: string;
    minDepositFormatted?: string;
    feeModel?: string;
    ragequitEnabled: boolean;
    lockPeriod?: number;
  };
  links: {
    moltbook?: string;
    dashboard?: string;
    github?: string;
  };
}

// Bundled Pinata credentials — used by all CLI users for syndicate metadata.
// Override with PINATA_API_KEY / PINATA_GATEWAY env vars if needed.
const BUNDLED_PINATA_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI2NDQ0MGViOC1hYTYyLTQzY2EtOGYwNC04MDZjZmNjY2Y4YTUiLCJlbWFpbCI6ImltdGhhdGNhcmxvc0BnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGluX3BvbGljeSI6eyJyZWdpb25zIjpbeyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJGUkExIn1dLCJ2ZXJzaW9uIjoxfSwibWZhX2VuYWJsZWQiOmZhbHNlLCJzdGF0dXMiOiJBQ1RJVkUifSwiYXV0aGVudGljYXRpb25UeXBlIjoic2NvcGVkS2V5Iiwic2NvcGVkS2V5S2V5IjoiMWJhZWFmMzQwODM3MGQ0NGZkZWEiLCJzY29wZWRLZXlTZWNyZXQiOiIzNDcxMmU5MTkyYTgxNWFhMGRmNjUyYjYyMDQzODQ1MDJjMmU0YWE0MDhkZTJmOTU2NWYwOTk3YTNlY2U3NGU3IiwiZXhwIjoxODAxMjc2ODExfQ.7OMJiOATpqkSwe7Orrpt2b8H_-czH-W61vBm4AHtqfA";
const BUNDLED_PINATA_GATEWAY = "https://sherwood.mypinata.cloud";

function getPinataApiKey(): string {
  return process.env.PINATA_API_KEY || BUNDLED_PINATA_JWT;
}

function getPinataGateway(): string {
  return process.env.PINATA_GATEWAY || BUNDLED_PINATA_GATEWAY;
}

/**
 * Upload JSON metadata to IPFS via Pinata.
 * Returns the IPFS URI (ipfs://Qm...).
 */
export async function uploadMetadata(metadata: SyndicateMetadata): Promise<string> {
  const apiKey = getPinataApiKey();

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: {
        name: `sherwood-syndicate-${metadata.name.toLowerCase().replace(/\s+/g, "-")}`,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pinata upload failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as { IpfsHash: string };
  return `ipfs://${result.IpfsHash}`;
}

/**
 * Fetch and parse metadata from an IPFS URI.
 * Supports ipfs:// protocol URIs and raw CIDs.
 */
export async function fetchMetadata(ipfsURI: string): Promise<SyndicateMetadata> {
  const gateway = getPinataGateway();
  let cid: string;

  if (ipfsURI.startsWith("ipfs://")) {
    cid = ipfsURI.slice(7);
  } else if (ipfsURI.startsWith("Qm") || ipfsURI.startsWith("bafy")) {
    cid = ipfsURI;
  } else {
    throw new Error(`Invalid IPFS URI: ${ipfsURI}`);
  }

  const url = `${gateway}/ipfs/${cid}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch metadata from ${url} (${response.status})`);
  }

  return (await response.json()) as SyndicateMetadata;
}
