# Aether Cloud OS — Documentation

This directory is the **only** place documentation lives. If you find a `.md` file outside it (other
than the root [`README.md`](../README.md) and the per-package `packages/*/README.md`), it is a
mistake.

---

## Getting started

| Document                                            | Contents                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| [DEVELOPMENT.md](getting-started/DEVELOPMENT.md)     | Prerequisites, first run, workspace commands, testing, debugging     |
| [FIRST-RUN.md](getting-started/FIRST-RUN.md)         | Creating the owner account, pairing your first host, a tour          |
| [CONTRIBUTING.md](getting-started/CONTRIBUTING.md)   | Branching, commit style, review expectations, definition of done     |

## Architecture

| Document                                            | Contents                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| [OVERVIEW.md](architecture/OVERVIEW.md)              | Components, the backend↔agent split, request and data flows          |
| [DATA-MODEL.md](architecture/DATA-MODEL.md)          | Schema, the migration runner, and how to add a migration             |
| [REALTIME.md](architecture/REALTIME.md)              | WebSocket protocols: terminal and agent, auth, close codes           |

## Operations

| Document                                                        | Contents                                                |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| [DEPLOYMENT.md](operations/DEPLOYMENT.md)                        | Installer, Caddy modes, upgrades, the `aether` CLI       |
| [HOST-AGENTS.md](operations/HOST-AGENTS.md)                      | Pairing, the agent service, revoking, troubleshooting    |
| [BACKUP-AND-RESTORE.md](operations/BACKUP-AND-RESTORE.md)        | What to back up, how, and how to restore                 |
| [TROUBLESHOOTING.md](operations/TROUBLESHOOTING.md)              | Symptom → cause → fix                                    |

## Security

| Document                                            | Contents                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| [SECURITY-MODEL.md](security/SECURITY-MODEL.md)      | Trust boundaries, authentication, authorization, sandboxing          |
| [HARDENING.md](security/HARDENING.md)                | Checklist for exposing an instance to the internet                   |

## Reference

| Document                                                | Contents                                              |
| ------------------------------------------------------- | ----------------------------------------------------- |
| [API.md](reference/API.md)                               | Every HTTP endpoint, permission, and payload           |
| [CONFIGURATION.md](reference/CONFIGURATION.md)           | Every environment variable, its default, and its effect |
| [PROJECT-STRUCTURE.md](reference/PROJECT-STRUCTURE.md)   | Directory-by-directory map of the repository            |
| [CODE-STANDARDS.md](reference/CODE-STANDARDS.md)         | TypeScript conventions, layering rules, error handling  |

## Status

| Document                                                | Contents                                              |
| ------------------------------------------------------- | ----------------------------------------------------- |
| [KNOWN-LIMITATIONS.md](status/KNOWN-LIMITATIONS.md)      | **Read this.** What is deliberately not built, and why |
| [DECISION-LOG.md](status/DECISION-LOG.md)                | Why the stack is what it is                           |
| [RELEASE-AUDIT.md](status/RELEASE-AUDIT.md)              | Last pre-deploy verification: what was checked and found |

---

## A note on history

An earlier documentation set described a system that was never built — Express instead of Fastify,
Prisma instead of hand-written SQL, Argon2 instead of bcrypt, S3/MinIO storage, nginx, 2FA, and a
ten-phase roadmap. It was deleted rather than kept, because a document that confidently describes a
system you do not have is worse than no document. If you need the reasoning behind a choice, look in
[DECISION-LOG.md](status/DECISION-LOG.md); everything there describes the code in this repository.
