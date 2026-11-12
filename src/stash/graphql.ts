// A minimal client for stash's GraphQL endpoint (`graphql`, relative to
// stash's base URL like every other request, so it works behind a path
// prefix). Plain fetch: testable with a fake, and independent of stash's
// Apollo client. stash's own Apollo cache is refreshed best-effort through
// apollo.ts where the UI would otherwise show stale data.
import { stashUrl } from "./url.ts";

export interface GraphQLOptions {
  /** default: globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** stash's base URL; default: from <base href> */
  baseUrl?: string;
}

export class GraphQLRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphQLRequestError";
  }
}

/** runs one query or mutation; rejects on HTTP errors and on GraphQL errors */
export async function graphqlRequest<T>(query: string, variables: Record<string, unknown>, opts: GraphQLOptions = {}): Promise<T> {
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const res = await doFetch(stashUrl("graphql", opts.baseUrl), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GraphQLRequestError(`stash GraphQL request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
  if (body.errors && body.errors.length > 0) {
    throw new GraphQLRequestError(body.errors.map((e) => e.message || "unknown error").join("; "));
  }
  if (body.data === undefined || body.data === null) throw new GraphQLRequestError("stash GraphQL response without data");
  return body.data;
}
