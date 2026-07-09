# Design Document for A2A Style Agent Card

## 1. Overview
The goal of this design is to implement a session/provider-specific A2A style agent card JSON issuance, which includes agent name, capabilities, status, and endpoint. The existing mesh heartbeat will be extended to facilitate card updates, and a new route `GET /.well-known/agent-card.json` will be introduced for retrieval.

## 2. Changed File Paths and Key Changes
- **Files to Update**:
  - `src/core/provider-registry.ts`
  - `src/core/cli-mesh.ts`
  - `src/server/gateway.ts`

## 3. TypeScript Signatures
```typescript
interface AgentCard {
    name: string; // The name of the agent
    capabilities: string[]; // List of capabilities
    status: 'idle' | 'working' | 'error'; // Current status of the agent
    endpoint: string; // The endpoint for the agent
}

interface MeshSession {
    sessionId: string;
    agentId: string;
    status: 'idle' | 'thinking' | 'coding' | 'reviewing' | 'discussing' | 'done'; // Extended to include status for agent card
}
```

## 4. Agent Card JSON Schema
```json
{
  "type": "object",
  "properties": {
    "agents": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "capabilities": { "type": "array", "items": { "type": "string" } },
          "status": { "type": "string", "enum": ["idle", "working", "error"] },
          "endpoint": { "type": "string" }
        },
        "required": ["name", "capabilities", "status", "endpoint"]
      }
    }
  },
  "required": ["agents"]
}
```

## 5. Connection Points
- **Update Endpoint**: Extend the `mesh heartbeat` functionality to include A2A agent card updates based on session status updates.
- **Retrieval Endpoint**: `GET /.well-known/agent-card.json` will serve the current state of the agent cards.

## 6. Risks
- **Existing Bus Replacement**: The design strictly avoids replacing existing bus functionality; it acts as an identity and capabilities advertisement layer.
- **Concurrency**: Updating and reading agent cards concurrently could result in race conditions unless managed properly.
- **Schema Validation**: Must ensure the JSON schema is enforced to avoid API misuse.

### Conclusion
This design outlines the necessary implementations and considerations required for issuing and updating the A2A agent cards while preserving the current system architecture. Further implementation can proceed after approval of this design document.