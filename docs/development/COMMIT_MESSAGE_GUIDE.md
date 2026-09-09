# Commit Message Guide

This project follows a simple and consistent commit message pattern to make the Git history easier to read, search, and understand.

## Commit Message Format

<type>: <short description>

## Example

feat: add user profile page
fix: correct login validation error
docs: update API usage instructions

## Allowed Commit Types
Type	Use When
feat:	Adding a new feature
fix:	Fixing a bug in existing functionality
bug:	Reporting or addressing a known bug
chore:	Maintenance tasks that do not change application behavior
docs:	Documentation-only changes
refactor:	Code changes that do not add features or fix bugs
style:	Formatting, spacing, naming, or lint changes without logic changes
test:	Adding or updating tests
perf:	Improving performance
build:	Changes to build system, dependencies, or project configuration
ci:	Changes to CI/CD pipelines or automation
revert:	Reverting a previous commit
security:	Security-related changes
wip:	Work in progress, temporary commits only

## Examples
Feature
feat: add workout history page
feat: create movement search endpoint

Fix
fix: prevent duplicate exercise entries
fix: correct date format on agenda page

Bug
bug: address incorrect XP calculation
bug: handle missing equipment data

Chore
chore: update project dependencies
chore: remove unused imports

Documentation
docs: add commit message guide
docs: update setup instructions

Refactor
refactor: simplify movement service logic
refactor: reorganize dashboard components

Tests
test: add unit tests for challenge rewards
test: update API integration tests

Performance
perf: optimize movement query loading
perf: reduce dashboard render time

Build
build: update Docker configuration
build: add environment variable validation

CI/CD
ci: add backend test workflow
ci: update deployment 

Security
security: sanitize uploaded file names
security: restrict admin-only endpoints