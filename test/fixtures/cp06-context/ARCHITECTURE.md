# Ten-pack fixture architecture

The fixture uses an in-memory boundary around API, persistence, and presentation behavior. All operations are deterministic and make no network or account access.

## Trust boundary

Authenticated identity is authoritative for ownership. Cross-account operations neither disclose existence nor mutate state.
