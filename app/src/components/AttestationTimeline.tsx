import type { AttestationItem } from "@/lib/eas-queries";
import { truncateAddress, getAddresses } from "@/lib/contracts";

interface AttestationTimelineProps {
  attestations: AttestationItem[];
  /** Map of agentId (string) → display name from ERC-8004 identity */
  agentNames?: Record<string, string>;
  /** Map of lowercase address → display name for attester resolution */
  addressNames?: Record<string, string>;
  /** Chain the attestations belong to — picks the correct EAS explorer.
   *  Defaults to the primary chain if omitted. */
  chainId?: number;
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function badgeLabel(att: AttestationItem): string {
  if (att.revoked) return "REVOKED";
  switch (att.type) {
    case "JOIN_REQUEST": return "JOIN";
    case "APPROVED": return "APPROVED";
    case "VENICE_INFERENCE": return "INFERENCE";
    case "TRADE_EXECUTED": return "TRADE";
    case "RESEARCH": return "RESEARCH";
  }
}

function badgeType(att: AttestationItem): string {
  if (att.revoked) return "revoked";
  return att.type;
}

export default function AttestationTimeline({
  attestations,
  agentNames,
  addressNames,
  chainId,
}: AttestationTimelineProps) {
  const addresses = getAddresses(chainId);

  function agentLabel(agentId: bigint): string {
    const idStr = agentId.toString();
    return agentNames?.[idStr] || `Agent #${idStr}`;
  }

  function attesterName(att: AttestationItem): string {
    return addressNames?.[att.attester.toLowerCase()] || truncateAddress(att.attester);
  }

  function renderDescription(att: AttestationItem) {
    switch (att.type) {
      case "JOIN_REQUEST":
        return (
          <>
            <span style={{ color: "var(--color-accent)" }}>
              {att.agentId !== undefined ? agentLabel(att.agentId) : attesterName(att)}
            </span>{" "}
            requested to join
          </>
        );
      case "APPROVED":
        return (
          <>
            <span style={{ color: "var(--color-accent)" }}>
              {att.agentId !== undefined ? agentLabel(att.agentId) : attesterName(att)}
            </span>{" "}
            approved
          </>
        );
      case "VENICE_INFERENCE":
        return (
          <>
            <span style={{ color: "var(--color-accent)" }}>
              {attesterName(att)}
            </span>{" "}
            ran inference
            {att.model && (
              <span style={{ color: "rgba(255,255,255,0.5)" }}> ({att.model})</span>
            )}
          </>
        );
      case "TRADE_EXECUTED":
        return (
          <>
            <span style={{ color: "var(--color-accent)" }}>
              {attesterName(att)}
            </span>{" "}
            executed {att.routing?.toLowerCase() || "trade"}
          </>
        );
      case "RESEARCH":
        return (
          <>
            <span style={{ color: "var(--color-accent)" }}>
              {attesterName(att)}
            </span>{" "}
            researched
            {att.queryType && (
              <span style={{ color: "rgba(255,255,255,0.5)" }}> ({att.queryType})</span>
            )}
          </>
        );
    }
  }

  function renderDetail(att: AttestationItem) {
    if (att.type === "JOIN_REQUEST" && att.message) {
      return (
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{
            fontSize: "10px",
            color: "rgba(255,255,255,0.5)",
            marginTop: "4px",
            fontStyle: "italic",
          }}
        >
          &ldquo;{att.message}&rdquo;
        </div>
      );
    }

    if (att.type === "VENICE_INFERENCE" && att.promptTokens !== undefined) {
      return (
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)", marginTop: "4px" }}
        >
          {att.promptTokens} in, {att.completionTokens} out tokens
        </div>
      );
    }

    if (att.type === "TRADE_EXECUTED" && att.amountOut) {
      return (
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)", marginTop: "4px" }}
        >
          {att.amountOut} received
        </div>
      );
    }

    if (att.type === "RESEARCH" && att.prompt) {
      return (
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{
            fontSize: "10px",
            color: "rgba(255,255,255,0.5)",
            marginTop: "4px",
            fontStyle: "italic",
          }}
        >
          &ldquo;{att.prompt}&rdquo;
        </div>
      );
    }

    return null;
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Attestation History</span>
        <span style={{ color: "rgba(255,255,255,0.55)" }}>
          {attestations.length}
        </span>
      </div>

      {attestations.length === 0 ? (
        <div
          className="font-[family-name:var(--font-plus-jakarta)] text-xs"
          style={{ color: "rgba(255,255,255,0.55)", padding: "2rem 0" }}
        >
          No attestations yet
        </div>
      ) : (
        <div className="flex flex-col" style={{ maxHeight: "480px", overflowY: "auto" }}>
          {attestations.map((att) => (
            <div key={att.uid} className="attestation-item">
              <div className="flex items-start gap-3">
                {/* Type badge */}
                <span
                  className="attestation-badge"
                  data-type={badgeType(att)}
                >
                  {badgeLabel(att)}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="font-[family-name:var(--font-plus-jakarta)] text-xs text-white">
                    {renderDescription(att)}
                  </div>

                  {renderDetail(att)}

                  <div
                    className="flex items-center gap-3 mt-1 font-[family-name:var(--font-plus-jakarta)]"
                    style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)" }}
                  >
                    <span>{formatTime(att.time)}</span>
                    <span>from {attesterName(att)}</span>
                    {att.txid && (
                      <>
                        <a
                          href={`${addresses.blockExplorer}/tx/${att.txid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="attestation-link"
                        >
                          [TX]
                        </a>
                        <a
                          href={`${addresses.easExplorer}/attestation/view/${att.uid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="attestation-link"
                        >
                          [EAS]
                        </a>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
