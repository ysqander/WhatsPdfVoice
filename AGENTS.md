# Contributor Guide

This document provides guidelines for developers and AI agents working on the WhatsPdfVoice repository.

## Project Structure Overview

- **Client (`client/`)**: React/TypeScript frontend (Vite, Tailwind).
- **Server (`server/`)**: Express/TypeScript backend.
- **Shared (`shared/`)**: TypeScript types and Drizzle schema used by both client and server.

## Testing Instructions

- Test files are located in `__tests__` directories within each workspace (`client/`, `server/`, `shared/`).
- File naming convention: `*.test.ts` or `*.test.tsx`.
- **Run all tests:**
  ```bash
  npx vitest
  ```
- **Run tests for a specific workspace (e.g., client):**
  ```bash
  npx vitest --project client
  ```
  (Workspaces: `client`, `server`, `shared`)
- **Run a specific test file (e.g., a client test):**
  ```bash
  npx vitest client/__tests__/Home.test.tsx
  ```
- **Focus on a specific test name or pattern:**
  ```bash
  npx vitest -t "your test name pattern"
  ```
- Ensure all tests pass before committing. Update tests when refactoring related code.
- Add or update tests for the code you change, even if nobody asked.

## PR instructions
Title format: `[client|server|shared|infra|docs] Short descriptive title`
Example: `[client] Fix PDF rendering issue on mobile`
