import React, { useEffect, useState } from 'react';

interface Status {
  agents: Record<string, string>;
  queueLength: number;
  cpuUsage: number;
  memoryUsage: number;
}

const AgentDashboard: React.FC = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const host = (window.location.port === '3000' || window.location.port === '5173')
          ? `${window.location.protocol}//${window.location.hostname}:6200`
          : '';
        const res = await fetch(`${host}/monitor`);
        if (res.ok) {
          const data = await res.json();
          setStatus({
            agents: data.agentStates ?? {},
            queueLength: data.queueLength ?? 0,
            cpuUsage: data.cpu ?? 0,
            memoryUsage: data.memory ?? 0,
          });
          setError(null);
        } else {
          setError(`HTTP Error: ${res.status}`);
        }
      } catch (e) {
        console.error('Failed to fetch status', e);
        setError(e instanceof Error ? e.message : 'Failed to fetch status');
      }
    };
    const interval = setInterval(fetchStatus, 2000);
    fetchStatus();
    return () => clearInterval(interval);
  }, []);

  if (!status) {
    if (error) {
      return <div style={{ color: 'red', padding: '1rem' }}>Error: {error}</div>;
    }
    return <div>Loading...</div>;
  }

  return (
    <div style={{ padding: '1rem' }}>
      <h2>Agent Monitoring Dashboard</h2>
      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>Error: {error}</div>}
      <section>
        <h3>Agents</h3>
        <ul>
          {Object.entries(status.agents).map(([name, state]) => (
            <li key={name}>
              {name}: {state}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Queue Length</h3>
        <p>{status.queueLength}</p>
      </section>
      <section>
        <h3>Performance</h3>
        <p>CPU: {status.cpuUsage}%</p>
        <p>Memory: {status.memoryUsage}%</p>
      </section>
    </div>
  );
};

export default AgentDashboard;
