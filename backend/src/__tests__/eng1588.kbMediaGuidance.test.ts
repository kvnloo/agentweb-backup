// ENG-1588: the list_/read_knowledge_base_files tool descriptions must route
// media to materialize_knowledge_base_asset ONLY for gdrive: identifiers.
// Non-Drive identifiers (private/public/clickup/foreplay) must NOT be sent
// there — it is Google-Drive-only by design.
import "../emma/tools";
import { emmaToolRegistry } from "../emma/registry";

function getDescription(name: string): string {
  const tool = emmaToolRegistry.getTool(name);
  const def = tool?.definition;
  expect(def?.description).toBeTruthy();
  return def!.description as string;
}

describe("ENG-1588 KB media guidance routing", () => {
  it("list_knowledge_base_files conditions materialize guidance on gdrive: identifiers", () => {
    const desc = getDescription("list_knowledge_base_files");
    // gdrive path still points at materialize_knowledge_base_asset
    expect(desc).toMatch(/gdrive:.*materialize_knowledge_base_asset/s);
    // non-Drive identifiers are explicitly excluded from that routing
    expect(desc).toMatch(/non-Drive|materialize_knowledge_base_asset cannot handle/i);
  });

  it("read_knowledge_base_files conditions materialize guidance on gdrive: identifiers", () => {
    const desc = getDescription("read_knowledge_base_files");
    expect(desc).toMatch(/gdrive:.*materialize_knowledge_base_asset/s);
    expect(desc).toMatch(/non-Drive|materialize_knowledge_base_asset is Google-Drive-only/i);
  });

  it("materialize_knowledge_base_asset still declares itself Google-Drive-only", () => {
    const desc = getDescription("materialize_knowledge_base_asset");
    expect(desc).toMatch(/only supports Google Drive.*gdrive:/i);
  });
});
