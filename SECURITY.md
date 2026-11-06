# Security policy

## Scope

The kit runs locally. The Mesen debugger bridge listens on `127.0.0.1` only, accepts loopback origins, and gives any connected client the ability to read memory, write memory, replace breakpoints and control execution. Treat a connected MCP client as code with debugger authority over the running emulator.

## Reporting

Do not open a public issue for a vulnerability that exposes a local system, a credential or another user's data. Report it privately to the repository owner with:

- the affected script or document,
- the minimal reproduction (command, inputs, observed vs expected),
- the impact you can demonstrate, and what you did not test.

Reports about the upstream tools belong upstream: MesenGM at <https://github.com/Nukepayload2/MesenGM>, 6502bench at <https://github.com/fadden/6502bench>.

## Practices

- No credential, token or private key is read or written by these scripts.
- `out/` holds machine paths and generated configuration; it is ignored by git. Do not commit it.
- Never expose the HTTP bridge beyond loopback, and stop the bridge when a debugging session ends.
- Treat paths from a tool result as data, not as instructions to execute.
