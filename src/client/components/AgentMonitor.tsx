import React, { useEffect, useState } from 'react';

interface AgentStatus {
  id: string;
  status: string;
  score: number;
}

const AgentMonitor: React.FC = () => {
  const [agents, setAgents] = useState<AgentStatus[]>([]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    const maxDelay = 30000;
    let isMounted = true;

    const connect = () => {
      if (!isMounted) return;

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const hostname = window.location.hostname;
      const port = window.location.port;
      const wsPort = (port === '3000' || port === '5173') ? '6201' : port;
      const url = `${wsProtocol}//${hostname}${wsPort ? `:${wsPort}` : ''}/agents`;

      ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const data: AgentStatus[] = JSON.parse(event.data);
          setAgents(data);
        } catch (e) {
          console.error('Failed to parse agent update', e);
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket error', e);
      };

      ws.onclose = () => {
        if (!isMounted) return;
        timeoutId = setTimeout(() => {
          delay = Math.min(delay * 2, maxDelay);
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (ws) {
        ws.close();
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
      {agents.map((agent) => (
        <div key={agent.id} className="border rounded p-3 shadow-sm">
          <h3 className="font-semibold">{agent.id}</h3>
          <p>Status: {agent.status}</p>
          <p>Score: {agent.score}</p>
        </div>
      ))}
    </div>
  );
};

export default AgentMonitor;
