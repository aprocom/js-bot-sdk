import { dialog } from '@dlghq/dialog-api/js';

export enum ListMode {
  UNKNOWN = dialog.ListLoadMode.LISTLOADMODE_UNKNOWN,
  FORWARD = dialog.ListLoadMode.LISTLOADMODE_FORWARD,
  BACKWARD = dialog.ListLoadMode.LISTLOADMODE_BACKWARD,
  BOTH = dialog.ListLoadMode.LISTLOADMODE_BOTH,
}
