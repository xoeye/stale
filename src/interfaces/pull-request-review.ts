import {IUser} from './user';

export interface IPullRequestReview {
  user: IUser | null;
  // Absent while the review is pending
  submitted_at?: string;
}
