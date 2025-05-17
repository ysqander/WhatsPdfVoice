# Linting Policy and Gradual Adoption Plan

This document outlines the current linting policy for the WhatsPdfVoice project and the plan for gradually increasing strictness to ensure code quality and maintainability.

Our primary tools are ESLint for JavaScript/TypeScript linting and Prettier for code formatting.

## Initial Phase (Current Status)

The project has recently had ESLint and Prettier integrated. To manage the initial large number of reported issues, we've taken the following steps:

1.  **Auto-formatting:** Most Prettier formatting issues have been resolved by running `eslint --fix .`. Developers should ensure their code is formatted with Prettier before committing.
2.  **Relaxed ESLint Rules:** Several ESLint rules have been temporarily downgraded from `error` to `warn` to allow for a smoother transition. This helps us focus on critical issues first without blocking development.

### Key Relaxed Rules (set to `warn` or permissive settings):

*   **`prettier/prettier`**: (Warn) Violations of Prettier formatting rules are warnings. Code should still be formatted correctly (often auto-fixed).
*   **`prefer-const`**: (Warn) Suggests using `const` for variables that are never reassigned.
*   **`react-hooks/exhaustive-deps`**: (Warn) Checks `useEffect` and other hooks dependencies. Important for correctness but can be noisy in existing code.
*   **`@typescript-eslint/no-explicit-any`**: (Warn) Discourages the use of `any`. We aim to reduce `any` usage over time.
*   **`@typescript-eslint/no-unused-vars`**: (Warn) Flags unused variables (ignoring those prefixed with `_`).
*   **`@typescript-eslint/no-unsafe-function-type`**: (Warn) Discourages the use of `Function` type without explicit parameters/return.
*   **`@typescript-eslint/ban-ts-comment`**: (Warn) Allows `// @ts-ignore` and `// @ts-expect-error` with a description.
*   **`@typescript-eslint/no-require-imports`**: (Warn) Discourages `require()` in favor of ES6 imports. (Server-side code to be refactored).
*   **`no-console`**: (Warn) Allows `console.warn`, `console.error`, `console.info`. Other `console` uses are warnings.
*   **`react/no-unknown-property`**: (Warn) Warns about unknown DOM properties in JSX, with specific exceptions like `cmdk-input-wrapper`.


### Rules Remaining as Errors (Examples - Non-Exhaustive):

*   Core TypeScript errors (e.g., type mismatches identified by `tsc`).
*   Core ESLint syntax errors or highly problematic patterns.
*   `@typescript-eslint/ban-ts-comment` (for `@ts-ignore` without description if not covered by the relaxed setting, generally discouraging its use).
*   Accessibility rules (`jsx-a11y`) if enabled and not overridden.

## Phased Plan for Increasing Strictness

The goal is to gradually move most of the `warn`-level rules back to `error` as the codebase is refactored and new code adheres to stricter standards.

**Phase 1: Stabilize and Address Criticals (Current - Next 1-2 Sprints)**

*   **Focus:** Fix all remaining ESLint **errors**.
*   **Action:** Developers address reported errors in their PRs. Continue to auto-format code.
*   **Review:** Periodically review the count of warnings.

**Phase 2: Tackle High-Impact Warnings (Next 2-4 Sprints)**

*   **Target Rules to upgrade from `warn` to `error` (one by one or in small groups):**
    *   `prefer-const`
    *   `react-hooks/exhaustive-deps` (This is crucial for React app stability)
    *   `@typescript-eslint/no-require-imports` (Refactor server code)
*   **Action:** Dedicate some tech debt time to fix existing instances of these warnings before changing them to errors. New code must comply.

**Phase 3: Stricter Typing and Code Style (Ongoing)**

*   **Target Rules:**
    *   Gradually reduce `@typescript-eslint/no-explicit-any` usage. Consider targeted refactoring.
    *   Re-evaluate `@typescript-eslint/no-unsafe-function-type` and aim to fix instances.
    *   Stricter `no-console` policy (e.g., disallow `console.info` or all `console` logs in production builds).
    *   Potentially enable more rules from `eslint-plugin-react`, `@typescript-eslint/eslint-plugin`, and `eslint-plugin-vitest` recommended sets if they were further customized or disabled.
*   **Action:** Ongoing effort. Encourage best practices in code reviews.

**Phase 4: Full Strictness (Long-term Goal)**

*   **Goal:** Most, if not all, previously relaxed rules are set to `error`.
*   The `LINTING_POLICY.md` will be updated to reflect the new baseline.

## Developer Responsibilities

*   **Run linters locally:** Before pushing code, run `npx eslint .` to check for issues.
*   **Format code:** Ensure code is formatted with Prettier (usually handled by editor integration or `eslint --fix`).
*   **Address linting issues:** Fix errors and warnings in your PRs, especially those related to rules that are targeted for the current phase.
*   **Discuss complex issues:** If a linting rule seems overly restrictive or problematic for a specific case, discuss it with the team to decide on the best course of action (e.g., disable the rule for a specific line with justification, or refine the rule configuration).

This policy aims to improve code quality systematically without causing undue disruption. It will be reviewed and updated periodically. 