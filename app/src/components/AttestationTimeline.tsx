import type { AttestationItem } from "@/lib/eas-queries";
import { truncateAddress, getAddresses } from "@/lib/contracts";

interface AttestationTimelineProps {
  attestations: AttestationItem[];
  /** Map of agentId (string) → display name from ERC-8004 identity */
  agentNames?: Record<string, string>;
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

export default function AttestationTimeline({
  attestations,
  agentNames,
}: AttestationTimelineProps) {
  const addresses = getAddresses();

  function agentLabel(agentId: bigint): string {
    const idStr = agentId.toString();
    return agentNames?.[idStr] || `Agent #${idStr}`;
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Attestation History</span>
        <span style={{ color: "rgba(255,255,255,0.3)" }}>
          {attestations.length}
        </span>
      </div>

      {attestations.length === 0 ? (
        <div
          className="font-[family-name:var(--font-jetbrains-mono)] text-xs"
          style={{ color: "rgba(255,255,255,0.3)", padding: "2rem 0" }}
        >
          No attestations yet
        </div>
      ) : (
        <div className="flex flex-col">
          {attestations.map((att) => (
            <div key={att.uid} className="attestation-item">
              <div className="flex items-start gap-3">
                {/* Type badge */}
                <span
                  className="attestation-badge"
                  data-type={att.revoked ? "revoked" : att.type}
                >
                  {att.revoked
                    ? "REVOKED"
                    : att.type === "JOIN_REQUEST"
                      ? "JOIN"
                      : "APPROVED"}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="font-[family-name:var(--font-jetbrains-mono)] text-xs text-white">
                    {att.type === "JOIN_REQUEST" ? (
                      <>
                        <span style={{ color: "var(--color-accent)" }}>
                          {agentLabel(att.agentId)}
                        </span>{" "}
                        requested to join
                      </>
                    ) : (
                      <>
                        <span style={{ color: "var(--color-accent)" }}>
                          {agentLabel(att.agentId)}
                        </span>{" "}
                        approved
                      </>
                    )}
                  </div>

                  {att.message && (
                    <div
                      className="font-[family-name:var(--font-jetbrains-mono)]"
                      style={{
                        fontSize: "10px",
                        color: "rgba(255,255,255,0.5)",
                        marginTop: "4px",
                        fontStyle: "italic",
                      }}
                    >
                      &ldquo;{att.message}&rdquo;
                    </div>
                  )}

                  <div
                    className="flex items-center gap-3 mt-1 font-[family-name:var(--font-jetbrains-mono)]"
                    style={{ fontSize: "9px", color: "rgba(255,255,255,0.3)" }}
                  >
                    <span>{formatTime(att.time)}</span>
                    <span>from {truncateAddress(att.attester)}</span>
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
