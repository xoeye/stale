import {ILabel} from './label';
import {IUser} from './user';

export interface IIssueEvent {
  created_at: string;
  event: string;
  label: ILabel;
  actor?: IUser | null;
}
