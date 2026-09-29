# Authentication and tenancy

Ownership comes only from the authenticated principal; request-supplied owner fields are ignored. Missing or forged fixture credentials return `401`. Cross-account read, update, and delete return a non-disclosing `404` and must not mutate state.
