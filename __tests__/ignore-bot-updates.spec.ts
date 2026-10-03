import {IComment} from '../src/interfaces/comment';
import {IIssueEvent} from '../src/interfaces/issue-event';
import {IIssuesProcessorOptions} from '../src/interfaces/issues-processor-options';
import {IPullRequestCommit} from '../src/interfaces/pull-request-commit';
import {IPullRequestReview} from '../src/interfaces/pull-request-review';
import {IUser} from '../src/interfaces/user';
import {IssuesProcessorMock} from './classes/issues-processor-mock';
import {alwaysFalseStateMock} from './classes/state-mock';
import {DefaultProcessorOptions} from './constants/default-processor-options';
import {generateIssue} from './functions/generate-issue';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The account behind repo-token, which adds the stale label
const tokenUser: IUser = {login: 'machine-xoeye', type: 'User'};
const human: IUser = {login: 'octocat', type: 'User'};
const gitstream: IUser = {login: 'gitstream-cm[bot]', type: 'Bot'};
const codecov: IUser = {login: 'codecov[bot]', type: 'Bot'};
// GitHub links commits authored as actions@github.com to this account
const actionsOrganization: IUser = {login: 'actions', type: 'Organization'};

const iso = (timestamp: number): string => new Date(timestamp).toISOString();

const labeled = (
  label: string,
  timestamp: number,
  actor: IUser
): IIssueEvent => ({
  event: 'labeled',
  created_at: iso(timestamp),
  label: {name: label},
  actor
});

const issueEvent = (
  event: string,
  timestamp: number,
  actor: IUser
): IIssueEvent => ({event, created_at: iso(timestamp), label: {}, actor});

const comment = (
  user: IUser,
  updatedAt: number,
  body = 'A comment'
): IComment => ({user, body, updated_at: iso(updatedAt)});

const commit = (
  author: IUser | null,
  committedAt: number
): IPullRequestCommit => ({
  author,
  commit: {committer: {date: iso(committedAt)}}
});

interface IStaleItem {
  markedStaleOn: number;
  updatedAt: number;
  isPullRequest?: boolean;
  ignoreBotUpdates?: boolean;
  removeStaleWhenUpdated?: boolean;
  // Events other than the stale label added at markedStaleOn
  events?: IIssueEvent[];
  // What listComments returns with since=markedStaleOn
  comments?: IComment[];
  commits?: IPullRequestCommit[];
  commitsRequestFails?: boolean;
  reviews?: IPullRequestReview[];
}

async function processStaleItem(
  item: Readonly<IStaleItem>
): Promise<IssuesProcessorMock> {
  const options: IIssuesProcessorOptions = {
    ...DefaultProcessorOptions,
    daysBeforeClose: 7,
    removeStaleWhenUpdated: item.removeStaleWhenUpdated ?? true,
    ignoreBotUpdates: item.ignoreBotUpdates ?? true
  };
  const issue = generateIssue(
    options,
    1,
    'A stale item',
    iso(item.updatedAt),
    iso(item.markedStaleOn - 200 * DAY),
    false,
    item.isPullRequest ?? false,
    ['Stale']
  );
  const processor = new IssuesProcessorMock(
    options,
    alwaysFalseStateMock,
    async page => (page === 1 ? [issue] : []),
    async () => item.comments ?? [],
    async () => ({
      creationDate: iso(item.markedStaleOn),
      events: [
        labeled('Stale', item.markedStaleOn, tokenUser),
        ...(item.events ?? [])
      ]
    }),
    undefined,
    undefined,
    async () => (item.commitsRequestFails ? undefined : item.commits ?? []),
    async () => item.reviews ?? []
  );

  await processor.processIssues(1);

  return processor;
}

describe('ignore-bot-updates', (): void => {
  describe('un-staling', (): void => {
    const markedStaleOn = Date.now() - 2 * DAY;

    // xoeye/vision-stratus#2673: gitstream reacts to the stale label
    const gitstreamReaction: IStaleItem = {
      markedStaleOn,
      updatedAt: markedStaleOn + 88 * SECOND,
      isPullRequest: true,
      events: [
        issueEvent('review_requested', markedStaleOn - 100 * DAY, human),
        labeled('missing-jira', markedStaleOn + 85 * SECOND, gitstream)
      ],
      comments: [comment(gitstream, markedStaleOn + 88 * SECOND)]
    };

    test('keeps the stale label when only a bot labeled and commented', async (): Promise<void> => {
      expect.assertions(2);

      const processor = await processStaleItem(gitstreamReaction);

      expect(processor.removedLabelIssues).toHaveLength(0);
      expect(processor.closedIssues).toHaveLength(0);
    });

    test('removes the stale label after bot activity when the option is off', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        ...gitstreamReaction,
        ignoreBotUpdates: false
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('removes the stale label when a human labeled the item', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + HOUR,
        events: [labeled('priority', markedStaleOn + HOUR, human)]
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('removes the stale label when a human commented', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + HOUR,
        comments: [comment(human, markedStaleOn + HOUR)]
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('keeps the stale label when a bot comment mentions a human', async (): Promise<void> => {
      expect.assertions(1);

      // The mention events name the mentioned user as their actor
      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + 61 * SECOND,
        events: [
          issueEvent('mentioned', markedStaleOn + 61 * SECOND, human),
          issueEvent('subscribed', markedStaleOn + 61 * SECOND, human)
        ],
        comments: [
          comment(
            gitstream,
            markedStaleOn + 60 * SECOND,
            '@octocat please link a Jira ticket'
          )
        ]
      });

      expect(processor.removedLabelIssues).toHaveLength(0);
    });

    test.each([true, false])(
      'keeps the stale label when a bot edited its comment 16 seconds after the stale label (option on: %s)',
      async (ignoreBotUpdates: boolean): Promise<void> => {
        expect.assertions(1);

        const processor = await processStaleItem({
          markedStaleOn,
          updatedAt: markedStaleOn + 16 * SECOND,
          isPullRequest: true,
          ignoreBotUpdates,
          comments: [comment(codecov, markedStaleOn + 16 * SECOND)]
        });

        expect(processor.removedLabelIssues).toHaveLength(0);
      }
    );

    test('removes the stale label when no bot or stale-label activity explains the update', async (): Promise<void> => {
      expect.assertions(1);

      // For example a body edit, which leaves no event
      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + DAY
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('removes the stale label when a non-actions organization acted', async (): Promise<void> => {
      expect.assertions(1);

      const organization: IUser = {login: 'xoeye', type: 'Organization'};
      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + HOUR,
        isPullRequest: true,
        commits: [commit(organization, markedStaleOn + HOUR)]
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('removes the stale label for human activity within the tolerance', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + 10 * SECOND,
        events: [labeled('priority', markedStaleOn + 10 * SECOND, human)]
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('removes the stale label when a human pushed before a bot reacted', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + HOUR + MINUTE,
        isPullRequest: true,
        events: [
          labeled(
            'Unresolved Threads',
            markedStaleOn + HOUR + MINUTE,
            gitstream
          )
        ],
        commits: [
          commit(human, markedStaleOn - 100 * DAY),
          commit(human, markedStaleOn + HOUR)
        ]
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('keeps the stale label when only automation pushed', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + HOUR + MINUTE,
        isPullRequest: true,
        commits: [
          commit(human, markedStaleOn - 100 * DAY),
          commit(actionsOrganization, markedStaleOn + HOUR),
          commit(gitstream, markedStaleOn + HOUR + MINUTE)
        ]
      });

      expect(processor.removedLabelIssues).toHaveLength(0);
    });

    test('removes the stale label when a pushed commit has no linked account', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + HOUR,
        isPullRequest: true,
        commits: [commit(null, markedStaleOn + HOUR)]
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('keeps the stale label when a bot approved the pull request', async (): Promise<void> => {
      expect.assertions(1);

      // xoeye/xoi-actions-playground#77: gitstream re-approves after the label
      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + 51 * SECOND,
        isPullRequest: true,
        reviews: [
          {user: gitstream, submitted_at: iso(markedStaleOn - 100 * DAY)},
          {user: gitstream, submitted_at: iso(markedStaleOn + 51 * SECOND)}
        ]
      });

      expect(processor.removedLabelIssues).toHaveLength(0);
    });

    test('removes the stale label when a human reviewed the pull request', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + HOUR,
        isPullRequest: true,
        reviews: [{user: human, submitted_at: iso(markedStaleOn + HOUR)}]
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });

    test('removes the stale label when the commits cannot be listed', async (): Promise<void> => {
      expect.assertions(1);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + 60 * SECOND,
        isPullRequest: true,
        events: [labeled('XL', markedStaleOn + 60 * SECOND, gitstream)],
        commitsRequestFails: true
      });

      expect(processor.removedLabelIssues).toHaveLength(1);
    });
  });

  describe('closing', (): void => {
    const markedStaleOn = Date.now() - 7 * DAY - HOUR;

    test('closes once days-before-close passed since the stale label, despite bot updates', async (): Promise<void> => {
      expect.assertions(2);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + DAY,
        comments: [comment(codecov, markedStaleOn + DAY)]
      });

      expect(processor.removedLabelIssues).toHaveLength(0);
      expect(processor.closedIssues).toHaveLength(1);
    });

    test('lets bot updates delay closing when the option is off', async (): Promise<void> => {
      expect.assertions(2);

      const processor = await processStaleItem({
        markedStaleOn,
        updatedAt: markedStaleOn + DAY,
        ignoreBotUpdates: false,
        comments: [comment(codecov, markedStaleOn + DAY)]
      });

      expect(processor.removedLabelIssues).toHaveLength(0);
      expect(processor.closedIssues).toHaveLength(0);
    });

    test.each([
      {pusher: human, closed: 0, outcome: 'delays closing'},
      {pusher: gitstream, closed: 1, outcome: 'does not delay closing'}
    ])(
      'with remove-stale-when-updated off, a push by $pusher.login $outcome',
      async ({pusher, closed}): Promise<void> => {
        expect.assertions(2);

        const processor = await processStaleItem({
          markedStaleOn,
          updatedAt: markedStaleOn + DAY,
          isPullRequest: true,
          removeStaleWhenUpdated: false,
          commits: [commit(pusher, markedStaleOn + DAY)]
        });

        expect(processor.removedLabelIssues).toHaveLength(0);
        expect(processor.closedIssues).toHaveLength(closed);
      }
    );

    test('does not close on the run that marks the item, even after an older stale cycle', async (): Promise<void> => {
      expect.assertions(2);

      const options: IIssuesProcessorOptions = {
        ...DefaultProcessorOptions,
        daysBeforeClose: 7,
        removeStaleWhenUpdated: true,
        ignoreBotUpdates: true
      };
      const olderStaleCycle = Date.now() - 30 * DAY;
      const issue = generateIssue(
        options,
        1,
        'An item that was stale before',
        iso(Date.now() - 10 * DAY),
        iso(Date.now() - 200 * DAY)
      );
      const processor = new IssuesProcessorMock(
        options,
        alwaysFalseStateMock,
        async page => (page === 1 ? [issue] : []),
        async () => [],
        async () => ({
          creationDate: iso(olderStaleCycle),
          events: [
            labeled('Stale', olderStaleCycle, tokenUser),
            issueEvent('unlabeled', olderStaleCycle + DAY, tokenUser)
          ]
        })
      );

      await processor.processIssues(1);

      expect(processor.staleIssues).toHaveLength(1);
      expect(processor.closedIssues).toHaveLength(0);
    });
  });
});
