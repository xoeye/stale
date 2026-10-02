import {IUser} from './user';

export interface IComment {
  user: IUser | null;
  body?: string;
  updated_at?: string;
}
