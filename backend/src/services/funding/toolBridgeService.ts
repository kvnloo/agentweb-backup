/**
 * ENG-2109 (B2): the process-wide tool bridge. ENG-2113 opens a run here when it starts
 * a `claude -p` session, and the internal route serves that session's MCP requests.
 */

import { EmmaToolBridgeExecutor } from "./emmaToolBridgeExecutor";
import { ToolBridge } from "./toolBridge";
import { ToolBridgeMcpAdapter } from "./toolBridgeMcp";

export const emmaToolBridgeExecutor = new EmmaToolBridgeExecutor();
// Reached only through the adapter, so closing a run always closes its MCP sessions too.
export const toolBridgeMcp = new ToolBridgeMcpAdapter(new ToolBridge(emmaToolBridgeExecutor));
