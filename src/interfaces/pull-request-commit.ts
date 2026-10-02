import {IUser} from './user';

export interface IPullRequestCommit {
  // The GitHub account linked to the commit author, null when unlinked
  author: IUser | null;
  commit: {
    committer: {
      date?: string;
    } | null;
  };
}
