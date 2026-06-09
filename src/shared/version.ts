/**
 * Single source of truth for the application version.
 *
 * The version is read from the repository's `package.json` so it is never
 * duplicated/hardcoded in source. `package.json` lives outside `rootDir`
 * (`./src`), so it is loaded at runtime via `createRequire` rather than a
 * compile-time `import ... from '../../package.json'` (which would violate the
 * tsconfig `rootDir` constraint and alter the `dist` layout).
 */
import { createRequire } from 'node:module';

/** Minimal typed view of the fields we read from package.json. */
interface PackageManifest {
  version: string;
}

const require = createRequire(__filename);
const manifest = require('../../package.json') as PackageManifest;

/** The application version, sourced from package.json (e.g. "1.0.0"). */
export const APP_VERSION: string = manifest.version;
