# Planet Radio Plugin for Volumio

This plugin adds Planet Radio stations to Volumio.

## Features

- Stream Planet Radio stations
- High quality AAC stream
- Simple and easy to use interface

## Installation

1. Go to Volumio's plugin section
2. Search for "Planet Radio"
3. Install the plugin
4. Restart Volumio

## Usage

After installation, Planet Radio will appear in your music sources. Simply click on it to start streaming.

## Development

### Code Quality

This project uses ESLint for linting and Prettier for code formatting.

#### Available Scripts

- `npm run lint` - Check for linting issues
- `npm run lint:fix` - Automatically fix linting issues
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check if code is properly formatted
- `npm run check` - Run both linting and format checks

#### Configuration

- **ESLint**: Configured in `eslint.config.js` with rules for Node.js development
- **Prettier**: Configured in `.prettierrc` with consistent formatting rules
- **Ignores**: Files and directories to ignore are specified in `.prettierignore`

#### Code Style

- Use `const` and `let` instead of `var`
- Use single quotes for strings
- Use template literals instead of string concatenation
- Use object shorthand notation
- Proper indentation (2 spaces)
- Semicolons required
