import { NextRequest, NextResponse } from "next/server";

const MAX_PAYLOAD_BYTES = 1024 * 512; // 512 KB

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json(
      { error: "IPFS upload is not configured" },
      { status: 503 },
    );
  }

  // Validate content length
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: "Payload too large" },
      { status: 413 },
    );
  }

  let body: { content: Record<string, unknown>; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.content || typeof body.content !== "object") {
    return NextResponse.json(
      { error: "Missing or invalid 'content' field" },
      { status: 400 },
    );
  }

  const pinataName = body.name || "sherwood-upload";

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: body.content,
      pinataMetadata: { name: pinataName },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Pinata upload failed (${response.status}): ${text}`);
    return NextResponse.json(
      { error: "IPFS upload failed" },
      { status: 502 },
    );
  }

  const result = (await response.json()) as { IpfsHash: string };
  return NextResponse.json({ ipfsHash: result.IpfsHash });
}
