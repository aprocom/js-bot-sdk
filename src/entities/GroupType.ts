/*
 * Copyright 2018 Dialog LLC <info@dlg.im>
 */

import { dialog } from '@dlghq/dialog-api';
import Group = dialog.Group;
import { getOpt } from './utils';

export abstract class GroupType {
  static from(api: Group) {
    const shortname = getOpt(api.shortname, null);

    switch (api.groupType) {
      case dialog.GroupType.GROUPTYPE_GROUP:
        if (shortname) {
          return new PublicGroupType(shortname);
        }

        return new PrivateGroupType();

      case dialog.GroupType.GROUPTYPE_CHANNEL:
        if (shortname) {
          return new PublicChannelType(shortname);
        }

        return new PrivateChannelType();

      default:
        return new UnknownGroupType();
    }
  }
}

export class PublicGroupType extends GroupType {
  public readonly shortname: string;

  constructor(shortname: string) {
    super();
    this.shortname = shortname;
  }
}

export class PrivateGroupType extends GroupType {
}

export class PublicChannelType extends GroupType {
  public readonly shortname: string;

  constructor(shortname: string) {
    super();
    this.shortname = shortname;
  }
}

export class PrivateChannelType extends GroupType {
}

export class UnknownGroupType extends GroupType {
}
