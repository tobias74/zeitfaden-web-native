# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Development

Install the web dependencies and run the browser app:

```bash
npm ci
npm run dev
```

Run verification:

```bash
npm run build
npm run lint
npm test
```

Generate large GPX and Google Takeout `Records.json` files for import testing:

```bash
npm run generate:geo -- --format both --points 100000 --out tmp/geo-fixtures
```

Generated files under `tmp/geo-fixtures` are ignored by git.

Useful options include `--seed` for repeatable random points, `--bounds
minLat,minLon,maxLat,maxLon` for a fixed area, `--center lat,lon` with
`--radius-km`, and `--start` plus `--interval-ms` for timestamp spacing. Run
`npm run generate:geo -- --help` for the full CLI reference.

## Tauri Desktop

This repo also contains a Tauri v2 native shell in `src-tauri`. The web
runtime keeps using OPFS/File System Access APIs, while the Tauri runtime uses
Rust-side scanning, absolute filesystem paths, native SQLite, and native
thumbnail files.

Windows is the primary native target. Install the Tauri Windows prerequisites,
including Rust and the Microsoft C++ build tools, then run:

```bash
npm run tauri:dev
```

If you run Cargo from Windows against this repo through the WSL UNC path, put
the Cargo target directory on a local Windows path to avoid UNC artifact
permission errors:

```powershell
$env:CARGO_TARGET_DIR='C:\Users\tobia\AppData\Local\Temp\zeitfaden-tauri-target'
cargo test --manifest-path \\wsl.localhost\Ubuntu\home\tobias\projects\zeitfaden-web-native\src-tauri\Cargo.toml
```

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
