# CloudSync backlog

## Managed CloudFront signing-key rotation

Investigate moving the CloudFront private signing key from Doppler to AWS Secrets Manager or KMS-backed encrypted storage and automating rotation with overlapping trusted public keys.

Do not store a plaintext signing key directly in PostgreSQL or rotate it at midnight without overlap. CloudFront key-group updates are control-plane operations with propagation time; replacing the only trusted key can interrupt file access. Any database-stored ciphertext would still require a root encryption key outside the database.

The v1 design keeps a validated base64-encoded PEM in Doppler and rotates the expiry of short-lived signed cookies. A future design should prove:

- old and new public keys overlap until every cookie signed by the old key expires;
- CloudFront distribution propagation is observed before issuing with the new key;
- private-key material is encrypted by a key that is not stored in PostgreSQL;
- rotation failure leaves the previous key usable;
- key access and rotation are auditable;
- no private-key value appears in application logs, command output, or deployment metadata.

