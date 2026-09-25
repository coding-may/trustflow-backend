# GitHub Actions CI/CD

This directory contains GitHub Actions workflow configurations for the TrustFlow Backend.

> **Keep this file and `backend-ci.yml` in sync.** If you change a step, job name, Node
> version, or service container in the workflow, update the description below in the same
> PR — see the pointer comment at the top of `backend-ci.yml`.

## Workflows

### Backend CI (`backend-ci.yml`)

Automatically runs on:

- **Pull Requests** that modify files in `backend/` directory or the workflow file itself
- **Push to main/develop** branches with the same paths

#### What it does

A single job, `ci`, displayed as **"Lint · TypeCheck · Test · Build"**, running on
`ubuntu-latest` with a `redis:7-alpine` service container (backs the Redis-integration
tests; tests that don't need it check `REDIS_URL` and skip). Steps, in order:

1. **Checkout**
2. **Setup Node.js** — version read from the repo-root `.nvmrc` (currently 20), with npm
   caching keyed on `backend/package-lock.json`
3. **Install dependencies** — `npm ci` (in `backend/`)
4. **Lint** — `npm run lint:check` (ESLint)
5. **Format check** — `npm run format:check` (Prettier)
6. **TypeScript check** — `npx tsc --noEmit`; blocks the PR on type errors
7. **Circular dependency check** — `npm run check:cycles` (`madge --circular`); catches an
   injection-token/service import cycle before it ships (Nest resolves those to an `undefined`
   token at runtime rather than a compile error — see #429)
8. **Wait for Redis** — polls the service container before trusting `REDIS_URL`
9. **Unit tests** — `npm run test:ci` (Jest, `--maxWorkers=2`, with `REDIS_URL` set)
10. **Build** — `npm run build` (`tsc`)
11. **Dependency vulnerability scan** — `npm audit --audit-level=high`; gates on high/critical
    findings only
12. **Upload coverage** — sends `backend/coverage` to Codecov (`fail_ci_if_error: false`, so a
    Codecov outage never blocks the PR)

#### Timeout

- `timeout-minutes: 5` for the job
- Prevents a stuck run from consuming CI minutes

#### Concurrency and permissions

- `permissions: contents: read` at the workflow level (least privilege for the job token)
- A `concurrency` group keyed on `${{ github.workflow }}-${{ github.ref }}` with
  `cancel-in-progress: true`, so a superseded push to the same PR/branch cancels the older run
  instead of letting both run to completion

## Branch Protection Rules (Recommended)

To enforce CI checks, configure these branch protection rules for `main`:

1. **Require status checks to pass before merging**
   - ✅ `Lint · TypeCheck · Test · Build` — the one check this workflow reports (verify the
     exact string on a recent PR's checks list; it can drift if the job's `name:` changes)

2. **Require branches to be up to date before merging**

3. **Require linear history** (optional)

## Local Testing

Before pushing, run these commands locally to catch issues early:

```bash
cd backend

# Install dependencies
npm install

# Run linter
npm run lint

# Check formatting
npm run format:check

# Run tests
npm test

# Run full CI suite locally
npm run test:ci && npm run build
```

## Troubleshooting

### Build Fails on `npm ci`

**Problem**: Missing `package-lock.json`

**Solution**:

```bash
cd backend
npm install
git add package-lock.json
git commit -m "Add package-lock.json"
```

### Linter Errors

**Problem**: Code doesn't pass ESLint checks

**Solution**:

```bash
npm run lint  # Auto-fix issues
```

### Formatting Errors

**Problem**: Code formatting doesn't match Prettier rules

**Solution**:

```bash
npm run format  # Auto-format code
```

### Test Failures

**Problem**: Tests fail in CI but pass locally

**Possible causes**:

- Environment differences (Node version)
- Missing environment variables
- Race conditions in async tests
- Timezone differences

**Solution**:

```bash
# Test with same Node version as CI
nvm use 20
npm run test:ci
```

### TypeScript Errors

**Problem**: Build fails with TypeScript compilation errors

**Solution**:

```bash
npx tsc --noEmit  # Check for errors without building
```

### Coverage Threshold Not Met

**Problem**: Code coverage below 50% threshold

**Solution**: Add more tests or adjust threshold in `package.json`:

```json
"coverageThreshold": {
  "global": {
    "branches": 50,
    "functions": 50,
    "lines": 50,
    "statements": 50
  }
}
```

## CI Minutes Optimization

Current optimizations:

- ✅ Path filtering (only runs on backend changes)
- ✅ npm cache for faster installs
- ✅ 5 minute job timeout prevents runaway jobs
- ✅ `cancel-in-progress` concurrency group cancels superseded runs on the same ref
- ✅ `--maxWorkers=2` for Jest in CI mode

## Adding Codecov (Optional)

To enable code coverage reporting:

1. Sign up at [codecov.io](https://codecov.io)
2. Add your repository
3. Get the upload token
4. Add `CODECOV_TOKEN` to GitHub repository secrets:
   - Settings → Secrets and variables → Actions → New repository secret

Coverage reports will appear as comments on PRs.

## Future Enhancements

- [ ] E2E integration tests with test database
- [x] Security scanning — `npm audit --audit-level=high` gates the build (Snyk/Dependabot
      integration is still open)
- [ ] Automated dependency updates
- [ ] Performance benchmarking
- [ ] Docker image build and push
- [ ] Staging deployment on merge to develop
- [ ] Production deployment on release tags
