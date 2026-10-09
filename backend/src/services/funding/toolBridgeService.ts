/**
 * ENG-2109 (B2): the process-wide tool bridge. ENG-2113 opens a run here when it starts
 * a `claude -p` session, and the internal route serves that session's MCP requests.
 */

import { EmmaToolBridgeExecutor } from "./emmaToolBridgeExecutor";
import { ToolBridge } from "./toolBridge";
import { ToolBridgeMcpAdapter } from "./toolBridgeMcp";

export const emmaToolBridgeExecutor = new EmmaToolBridgeExecutor();
export const toolBridge = new ToolBridge(emmaToolBridgeExecutor);
export const toolBridgeMcp = new ToolBridgeMcpAdapter(toolBridge);
