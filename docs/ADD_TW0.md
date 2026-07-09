# ADD_TW0

## Overview

`addTwo(a, b)` is a minimal end-to-end verification feature for the NCO backend. It exposes a pure domain function, a validation service, and a Fastify API endpoint at `POST /api/add`.

## Contract

Request:

```json
{
  "a": 1,
  "b": 1
}
```

Success response:

```json
{
  "result": 2,
  "ok": true
}
```

Validation failure response:

```json
{
  "error": "Invalid numbers",
  "message": "Invalid numbers: \"a\" must be a finite number",
  "statusCode": 400
}
```

## Notes

- Domain logic lives in `src/utils/math.ts`.
- Validation and response shaping live in `src/services/mathService.ts`.
- HTTP handling and request logging live in `src/server/routes/math.ts`.
- Coverage is enforced through Vitest unit and integration tests under `src/`.
