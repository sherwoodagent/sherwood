import type { AgentInfo } from "@/lib/syndicate-data";
import { formatUSDC, truncateAddress } from "@/lib/contracts";

interface AgentRosterProps {
  agents: AgentInfo[];
}

export default function AgentRoster({ agents }: AgentRosterProps) {
  return (
    <div className="panel">
      <div className="panel-title">
        <span>Registered Agents</span>
        <span style={{ color: "var(--color-accent)" }}>{agents.length}</span>
      </div>

      {agents.length === 0 ? (
        <div
          className="font-[family-name:var(--font-jetbrains-mono)] text-xs"
          style={{ color: "rgba(255,255,255,0.3)", padding: "2rem 0" }}
        >
          No agents registered
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {agents.map((agent) => {
            const spentPct =
              agent.dailyLimit > 0n
                ? Number((agent.spentToday * 100n) / agent.dailyLimit)
                : 0;

            return (
              <div key={agent.operatorEOA} className="agent-card">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="font-[family-name:var(--font-jetbrains-mono)] text-xs text-white">
                      {agent.identity?.name || `Agent #${agent.agentId.toString()}`}
                    </div>
                    {agent.identity?.name && (
                      <div
                        className="font-[family-name:var(--font-jetbrains-mono)]"
                        style={{
                          fontSize: "9px",
                          color: "var(--color-accent)",
                          marginTop: "1px",
                          opacity: 0.7,
                        }}
                      >
                        ERC-8004 #{agent.agentId.toString()}
                      </div>
                    )}
                    <div
                      className="font-[family-name:var(--font-jetbrains-mono)]"
                      style={{
                        fontSize: "10px",
                        color: "rgba(255,255,255,0.4)",
                        marginTop: "2px",
                      }}
                    >
                      {truncateAddress(agent.operatorEOA)}
                    </div>
                    {agent.identity?.description && (
                      <div
                        className="font-[family-name:var(--font-jetbrains-mono)]"
                        style={{
                          fontSize: "9px",
                          color: "rgba(255,255,255,0.3)",
                          marginTop: "2px",
                          fontStyle: "italic",
                        }}
                      >
                        {agent.identity.description}
                      </div>
                    )}
                  </div>
                  <span
                    className="glitch-tag text-[9px] px-1.5 py-0.5"
                    style={
                      agent.active
                        ? undefined
                        : {
                            background: "rgba(255,77,77,0.2)",
                            color: "#ff4d4d",
                          }
                    }
                  >
                    {agent.active ? "ACTIVE" : "INACTIVE"}
                  </span>
                </div>

                <div className="param-list" style={{ fontSize: "10px" }}>
                  <div className="param-row" style={{ padding: "0.4rem 0" }}>
                    <span className="param-key">Max/Tx</span>
                    <span className="param-val">
                      {formatUSDC(agent.maxPerTx)}
                    </span>
                  </div>
                  <div className="param-row" style={{ padding: "0.4rem 0" }}>
                    <span className="param-key">Daily Limit</span>
                    <span className="param-val">
                      {formatUSDC(agent.dailyLimit)}
                    </span>
                  </div>
                </div>

                {/* Spend progress bar */}
                <div style={{ marginTop: "0.5rem" }}>
                  <div
                    className="flex justify-between font-[family-name:var(--font-jetbrains-mono)]"
                    style={{ fontSize: "9px", color: "rgba(255,255,255,0.3)" }}
                  >
                    <span>Spent Today</span>
                    <span>
                      {formatUSDC(agent.spentToday)} /{" "}
                      {formatUSDC(agent.dailyLimit)}
                    </span>
                  </div>
                  <div className="spend-bar">
                    <div
                      className="spend-bar-fill"
                      style={{ width: `${Math.min(spentPct, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
