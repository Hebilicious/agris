import { createCatalogSubgraph } from "@agris/catalog-subgraph";

const catalogSubgraph = createCatalogSubgraph();

/**
 * Answer one catalog subgraph request.
 *
 * The Worker's own entrypoints in `index.ts` and the Alchemy catalog Worker under `infra/` both serve through it. It
 * imports nothing from the Workers runtime, so a deploy tool can load it.
 */
export async function executeCatalogSubgraph(request: Request): Promise<Response> {
  const response = await catalogSubgraph.fetch(request);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
