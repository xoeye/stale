import {IssuesProcessor} from '../src/classes/issues-processor';
import {IIssuesProcessorOptions} from '../src/interfaces/issues-processor-options';
import {alwaysFalseStateMock} from './classes/state-mock';
import {DefaultProcessorOptions} from './constants/default-processor-options';

// Fork-only feature: the `repo-owner` / `repo-name` inputs let one workflow run
// the action against other repositories. Any GitHub call that falls back to
// `context.repo` silently acts on the workflow's own repository instead.

const TARGET_PREFIX = '/repos/target-owner/target-repo';
const WORKFLOW_REPOSITORY = 'workflow-owner/workflow-repo';
const LONG_AGO = '2020-01-01T17:00:00Z';

const rawIssue = (
  number: number,
  labels: string[],
  isPullRequest = false
): object => ({
  number,
  title: `Item #${number}`,
  labels: labels.map(name => ({name})),
  created_at: LONG_AGO,
  updated_at: LONG_AGO,
  draft: false,
  pull_request: isPullRequest ? {} : null,
  state: 'open',
  locked: false,
  milestone: null,
  assignees: []
});

// A fake GitHub API: responses keyed on `<METHOD> <path below the repo>`.
const fakeResponseData = (
  method: string,
  route: string,
  query: URLSearchParams
): unknown => {
  switch (`${method} ${route}`) {
    case 'GET /issues':
      return query.get('page') === '1'
        ? [
            rawIssue(1, []), // old and unlabeled: gets marked stale
            rawIssue(2, ['Stale'], true), // stale PR: gets closed, branch deleted
            rawIssue(3, ['Stale']) // stale but commented on: gets un-staled
          ]
        : [];
    case 'GET /issues/3/comments':
      return [{user: {type: 'User'}, body: 'Still relevant'}];
    case 'GET /pulls/2':
      return {
        number: 2,
        head: {
          ref: 'stale-branch',
          repo: {full_name: 'target-owner/target-repo'}
        }
      };
    default:
      return method === 'GET' ? [] : {};
  }
};

describe('repo-owner and repo-name', (): void => {
  const originalRepository = process.env.GITHUB_REPOSITORY;

  beforeAll((): void => {
    // `context.repo` resolves to a different repository than the target.
    process.env.GITHUB_REPOSITORY = WORKFLOW_REPOSITORY;
  });

  afterAll((): void => {
    if (originalRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepository;
    }
  });

  test('every API call targets the configured repository instead of context.repo', async (): Promise<void> => {
    const opts: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      repoOwner: 'target-owner',
      repoName: 'target-repo',
      debugOnly: false,
      deleteBranch: true,
      removeStaleWhenUpdated: true,
      closePrLabel: 'closed-for-inactivity',
      labelsToAddWhenUnstale: 'active'
    };
    const processor = new IssuesProcessor(opts, alwaysFalseStateMock);

    // Intercept at the request layer: this sees the final URL of every call,
    // including paginated ones, and no request reaches the network.
    const offTarget: string[] = [];
    const onTarget: string[] = [];
    processor.client.hook.wrap('request', async (_request, options) => {
      const {method, url} = processor.client.request.endpoint.parse(options);
      const {pathname, searchParams} = new URL(url);
      const path = decodeURIComponent(pathname);

      if (!path.startsWith(`${TARGET_PREFIX}/`)) {
        offTarget.push(`${method} ${path}`);
        return {status: 200, url, headers: {}, data: {}};
      }

      const route = path.slice(TARGET_PREFIX.length);
      onTarget.push(`${method} ${route}`);
      return {
        status: 200,
        url,
        headers: {},
        data: fakeResponseData(method, route, searchParams)
      };
    });

    await processor.processIssues(1);

    expect(offTarget).toEqual([]);
    expect(onTarget).toEqual(
      expect.arrayContaining([
        'GET /issues',
        'GET /issues/1/events',
        'GET /issues/1/comments',
        'POST /issues/1/comments', // stale message
        'POST /issues/1/labels', // stale label
        'POST /issues/2/comments', // close message
        'POST /issues/2/labels', // close label
        'PATCH /issues/2', // close
        'GET /pulls/2',
        'DELETE /git/refs/heads/stale-branch', // head repo matched the target
        'DELETE /issues/3/labels/Stale', // un-stale
        'POST /issues/3/labels' // labels-to-add-when-unstale
      ])
    );
  });
});
