# Contributing

Thanks for contributing to BRIDGE Spot AI. This repo contains multiple services (Spot inspection, Smart Assistant, and voice backend). Please read the docs before making changes.

## Branching

- Create a feature branch from your main branch (e.g., `feature/<short-description>`).
- Keep changes focused to one area when possible.

## Commit messages

No commit style is enforced in the repo. Suggested format:

```
feat: add <short description>
fix: repair <short description>
chore: update <short description>
```

## Development checklist

- Validate your changes against the relevant service entrypoints:
  - Spot inspection API: `spot/app/main.py`
  - Smart Assistant backend: `smart_assistant/backend/app/main_lif.py`
  - Voice backend: `spot/backend/voice_server.py`
- Update documentation if behavior or configuration changes (see `docs/*`).
- Avoid committing secrets (e.g., `.env` contains API keys).

## Code style

- Python: follow PEP8.
- `ruff` is listed in `smart_assistant/backend/deployment/requirements/requirements_dev.txt`, but no config exists. TODO: add a `ruff.toml` or `pyproject.toml` and document the lint command.

## Tests

No automated test configuration is present (no `pytest.ini`, `pyproject.toml`, or `tox.ini`). TODO: add tests and a standard test command. Until then, verify changes manually by running services and checking the relevant UIs/APIs.

## Documentation updates

When code changes affect runtime behavior, update the docs:
- `README.md`
- `docs/architecture.md`
- `docs/getting-started.md`
- `docs/configuration.md`
- `docs/development.md`
- `docs/deployment.md`
- `docs/api.md`
- `docs/troubleshooting.md`

## CODEOWNERS (suggested)

No `CODEOWNERS` file exists. If you want to add one, consider a structure like:

```
# CODEOWNERS (suggested)
/spot/ @spot-team
/smart_assistant/ @assistant-team
/spot/backend/ @voice-team
/docs/ @docs-team
```

Replace owners with your GitHub handles or team names.

