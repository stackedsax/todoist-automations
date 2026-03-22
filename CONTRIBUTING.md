# Contributing to Todoist Automations

Thank you for your interest in contributing! This project is a collection of Google Apps Script automations that create Todoist tasks from various sources.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `npm install`
4. Follow the setup instructions in the README

## Project Structure

| File | Purpose |
|------|---------|
| `Code.js` | Gmail Stars → Todoist integration |
| `Fireflies.js` | Fireflies meeting recaps → Todoist integration |
| `appsscript.json` | Apps Script manifest and OAuth scopes |

## Development Workflow

1. Edit the relevant `.js` file locally
2. Push to Apps Script: `npx clasp push`
3. Test by running the function manually in the Apps Script editor
4. Check results in Todoist

## Adding a New Integration

Each integration should live in its own file (e.g. `MySource.js`) and follow the existing patterns:

- Read `TODOIST_API_TOKEN` from `PropertiesService.getScriptProperties()`
- Store any integration-specific config in Script Properties
- Provide a `setupX()` function for one-time configuration
- Provide a `createXTrigger()` function for scheduling
- Mark processed items as handled so they aren't reprocessed
- Update `.claspignore` to include the new file with `!MySource.js`
- Document the integration in the README

## Code Style

- Follow existing conventions in `Code.js` and `Fireflies.js`
- Keep functions focused and single-purpose
- Use meaningful variable names
- Only add comments where the logic isn't self-evident

## Submitting Changes

1. Create a feature branch from `main`
2. Make your changes and test thoroughly
3. Update the README if you've added or changed an integration
4. Submit a pull request with a clear description of what changed and why

## Reporting Issues

1. Check existing issues first
2. Create a new issue with:
   - Clear description of the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (OS, clasp version)

## Questions?

Open an issue for questions about development, usage, or contributions.
