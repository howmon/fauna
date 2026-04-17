# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest (`main`) | ✅ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

To report a security issue, email **awakejournal@gmail.com** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any suggested remediation if you have one

You can expect an acknowledgement within **48 hours** and a status update within **7 days**.

## Scope

The following are in scope:

- Server-side code (`server.js`, `relay/server/`)
- Authentication and token handling
- Data exposure through the store proxy or relay endpoints
- Remote code execution via the Figma plugin relay

## Out of Scope

- Vulnerabilities in third-party dependencies (report those upstream)
- Issues requiring physical access to the device
- Social engineering

## Disclosure Policy

We follow coordinated disclosure. Once a fix is available, we will publish a summary of the vulnerability and credit the reporter (unless you prefer to remain anonymous).
