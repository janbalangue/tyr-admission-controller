---
title: Identity and priority
---

# Identity and priority

Identity is optional for backward compatibility. Once `identity` is configured,
every provider request must present a valid JWT before Tyr reads the request
body. The default identity header is deliberately separate from
`Authorization`, because Tyr forwards that provider credential to OpenAI and
Anthropic. Tyr strips the configured identity credential header before
forwarding and rejects configuration that reuses a provider-forwarded header.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_OPENAI_API_KEY' \
  -H 'x-tyr-identity-token: Bearer YOUR_IDENTITY_JWT' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

Role lists use any-of semantics. `identity.roles.invoke` authorizes provider
routes, `identity.roles.operator` authorizes `/stats` and `/metrics`, and
`identity.roles.highPriority` grants access to the reserved high-priority token
headroom. Tenant, application, subject, and roles appear only in structured
audit events, never in Prometheus labels.

When identity is enabled, client-supplied `x-priority` is ignored even if the
legacy trusted-header option is true. Embedded applications can still supply
`GatewayOptions.resolvePriority(req, identity)` for custom policy; the verified
identity is passed as the second argument. Programmatic authenticators using a
custom credential header should also set `identity.credentialHeader` so Tyr
strips it before provider forwarding.

The legacy raw-header path remains available only when identity is not
configured:

```yaml
priority:
  trustHeader: true
```

Enable that fallback only behind a trusted proxy that removes client copies,
authenticates callers, and injects its own header.
