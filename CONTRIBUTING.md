# Contributing

1. Create a focused branch from `main`.
2. Add tests for every behavior change.
3. Run `npm run check`.
4. Include benchmark results when changing scheduler hot paths.
5. Explain any change to fairness, lease, or fencing semantics in the pull request.

Public APIs follow semantic versioning. Changes that can reorder already-valid work are treated as behavioral changes and must be documented.
