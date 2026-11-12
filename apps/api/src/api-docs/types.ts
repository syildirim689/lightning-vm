// The API reference: what each route does, in Turkish and English. Routes themselves (method, path, permissions)
// are read from the running controllers (api-reference.ts), so the list can never drift from the code; these
// files add the words. test/api-reference.test.mjs fails when a route has no entry or an entry has no route.
export type Text = { tr: string; en: string };

export type Field = {
  name: string;          // body / query / path field; nested fields as "tls.mode", array items as "sshKeyIds[]"
  type: string;          // string, integer, number, boolean, uuid, object, string[], uuid[], …; for enums: "string"
  required?: boolean;
  values?: string[];     // allowed values of an enum
  text: Text;            // what it means, limits, default
};

export type EndpointDoc = {
  tag: string;           // a key of tags in index.ts
  summary: Text;         // one short line: what the call does
  details?: Text;        // behaviour worth knowing: side effects, limits, async operations, who sees what
  params?: Field[];      // path parameters (:id …)
  query?: Field[];
  body?: Field[];
  example?: unknown;     // a realistic request body
  returns?: Text;        // what the answer contains
  errors?: string[];     // error codes this route itself may answer (besides the common ones)
  idempotencyKey?: boolean; // needs an Idempotency-Key header
  tokens?: false;        // refused with an API token: only from a signed-in browser
  internal?: true;       // not meant for integrations (setup wizard, provider callbacks, sign-in flows, probes)
};

export type Docs = Record<string, EndpointDoc>;
