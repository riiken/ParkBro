import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Proves the lint rule actually enforces architecture.md §4.2 (not just that it is configured).
const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const eslint = new ESLint({ cwd: repoRoot });

/** All boundaries-plugin messages, as "ruleId: message" (so an "unknown file" can never pass for a violation). */
async function boundaryErrors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId?.startsWith('boundaries/'))
    .map((m) => `${m.ruleId}: ${m.message}`);
}

const DEPENDENCY_VIOLATION = expect.arrayContaining([expect.stringMatching(/^boundaries\/dependencies: /)]);
function expectOnlyDependencyViolations(errors: string[]) {
  expect(errors).toEqual(DEPENDENCY_VIOLATION);
  expect(errors.every((e) => e.startsWith('boundaries/dependencies: '))).toBe(true);
}

describe('module boundaries lint', () => {
  it("rejects importing another module's internals", async () => {
    const errors = await boundaryErrors(
      'apps/api/src/modules/booking/application/x.ts',
      "import { databaseReadiness } from '../../system/readiness.ts';\nexport const x = databaseReadiness;\n",
    );
    expectOnlyDependencyViolations(errors);
  });

  it("allows importing another module's public index.ts", async () => {
    const errors = await boundaryErrors(
      'apps/api/src/modules/booking/application/x.ts',
      "import { databaseReadiness } from '../../system/index.ts';\nexport const x = databaseReadiness;\n",
    );
    expect(errors).toEqual([]);
  });

  it('allows imports within the same module and from platform', async () => {
    const errors = await boundaryErrors(
      'apps/api/src/modules/system/http/x.ts',
      "import { databaseReadiness } from '../readiness.ts';\nimport { errors as e } from '../../../platform/errors/domain-error.ts';\nexport const x = [databaseReadiness, e];\n",
    );
    expect(errors).toEqual([]);
  });

  it('rejects platform code importing a module', async () => {
    const errors = await boundaryErrors(
      'apps/api/src/platform/http/x.ts',
      "import { systemRoutes } from '../../modules/system/index.ts';\nexport const x = systemRoutes;\n",
    );
    expectOnlyDependencyViolations(errors);
  });

  it('rejects the composition root reaching into module internals', async () => {
    const errors = await boundaryErrors(
      'apps/api/src/x.ts',
      "import { systemRoutes } from './modules/system/http/routes.ts';\nexport const x = systemRoutes;\n",
    );
    expectOnlyDependencyViolations(errors);
  });
});
