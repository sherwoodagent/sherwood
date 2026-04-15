import type { AgentInfo } from "@/lib/syndicate-data";
import { truncateAddress } from "@/lib/contracts";

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
          className="font-[family-name:var(--font-plus-jakarta)] text-xs"
          style={{ color: "rgba(255,255,255,0.55)", padding: "2rem 0" }}
        >
          No agents registered
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {agents.map((agent) => (
            <div key={agent.agentAddress} className="sh-card--agent">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="font-[family-name:var(--font-plus-jakarta)] text-xs text-white">
                    {agent.identity?.name || `Agent #${agent.agentId.toString()}`}
                  </div>
                  {agent.identity?.name && (
                    <div
                      className="font-[family-name:var(--font-plus-jakarta)]"
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
                    className="font-[family-name:var(--font-plus-jakarta)]"
                    style={{
                      fontSize: "10px",
                      color: "rgba(255,255,255,0.4)",
                      marginTop: "2px",
                    }}
                  >
                    {truncateAddress(agent.agentAddress)}
                  </div>
                  {agent.identity?.description && (
                    <div
                      className="font-[family-name:var(--font-plus-jakarta)]"
                      style={{
                        fontSize: "9px",
                        color: "rgba(255,255,255,0.55)",
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
