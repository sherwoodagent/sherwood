/**
 * IPFS metadata upload/fetch via Sherwood API.
 *
 * Uploads go through the server-side API at sherwood.sh/api/ipfs/upload
 * which holds the Pinata JWT. CLI and app only need the gateway URL for reads.
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
    lockPeriod?: number;
  };
  links: {
    moltbook?: string;
    dashboard?: string;
    github?: string;
  };
}

const DEFAULT_PINATA_GATEWAY = "https://sherwood.mypinata.cloud";
const DEFAULT_UPLOAD_API = "https://sherwood.sh/api/ipfs/upload";

function getUploadApiUrl(): string {
  return process.env.SHERWOOD_API_URL
    ? `${process.env.SHERWOOD_API_URL}/api/ipfs/upload`
    : DEFAULT_UPLOAD_API;
}

function getPinataGateway(): string {
  return process.env.PINATA_GATEWAY || DEFAULT_PINATA_GATEWAY;
}

/**
 * Upload JSON to IPFS via the Sherwood API (server-side Pinata).
 * Returns the IPFS URI (ipfs://Qm...).
 */
async function uploadToIPFS(content: Record<string, unknown>, name: string): Promise<string> {
  const url = getUploadApiUrl();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, name }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`IPFS upload failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as { ipfsHash: string };
  return `ipfs://${result.ipfsHash}`;
}

/**
 * Pin arbitrary JSON to IPFS.
 * Used for research results and other generic JSON payloads.
 * Returns the IPFS URI (ipfs://Qm...).
 */
export async function pinJSON(content: Record<string, unknown>, name: string): Promise<string> {
  return uploadToIPFS(content, name);
}

/**
 * Upload syndicate metadata to IPFS.
 * Returns the IPFS URI (ipfs://Qm...).
 */
export async function uploadMetadata(metadata: SyndicateMetadata): Promise<string> {
  const name = `sherwood-syndicate-${metadata.name.toLowerCase().replace(/\s+/g, "-")}`;
  return uploadToIPFS(metadata as unknown as Record<string, unknown>, name);
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
