// ══════════════════════════════════════════════════════════════════════════════
// routes/mcp.js — MCP Streamable HTTP endpoint for outreach-proxy
//
// Mounts at /mcp on the main Express app. Uses stateless mode:
//   - Each POST creates a new McpServer + StreamableHTTPServerTransport
//   - sessionIdGenerator: undefined → no session tracking
//   - Server/transport closed when response closes
//
// This pattern is required for stateless mode (per MCP SDK docs) to avoid
// request ID collisions between concurrent clients.
//
// Connection from claude.ai:
//   Settings → Connectors → Add Custom Connector
//   URL: https://outreach-proxy-production-eb03.up.railway.app/mcp
//   No auth fields needed — proxy is open.
// ══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerMcpTools } = require("../lib/mcp");

const router = express.Router();

function createServer() {
  const server = new McpServer({
    name: "plexo-loop-os",
    version: "1.0.0",
  });
  registerMcpTools(server);
  return server;
}

// ── POST / — JSON-RPC requests from MCP client ────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error: " + err.message },
        id: null,
      });
    }
  }
});

// ── GET / and DELETE / — not supported in stateless mode ──────────────────────
router.get("/", (_, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless mode)" },
    id: null,
  });
});

router.delete("/", (_, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless mode)" },
    id: null,
  });
});

module.exports = router;
